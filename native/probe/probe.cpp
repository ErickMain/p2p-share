// Does WASAPI process loopback actually work on this machine?
//
// Microsoft documents a minimum of Windows 10 build 20348 for
// AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, but community reports say the
// API is present and functional from build 19041 as long as you compile with
// the Windows 11 SDK header. This machine is 19045 -- inside that unofficial
// window. Rather than write a 500-line native addon on a guess, this answers
// the question in three steps:
//
//   1. does ActivateAudioInterfaceAsync accept the process-loopback params?
//   2. does IAudioClient::Initialize succeed with a loopback format?
//   3. does audio actually arrive, and is any of it non-silent?
//
// Step 3 matters: a build can return S_OK from the first two and then hand
// back nothing but silence, which would look like a working API and a broken
// addon later.
//
// Usage:  probe.exe [pid]
// With no pid it excludes its own process tree, which in practice means
// "capture everything playing on this machine". Pass Discord's pid to see the
// exclusion that the app would actually use.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>
#include <wrl/client.h>
#include <stdio.h>
#include <stdlib.h>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;

namespace {

const char* Explain(HRESULT hr) {
  switch (hr) {
    case S_OK:                             return "S_OK";
    case E_NOTIMPL:                        return "E_NOTIMPL - this build does not implement process loopback";
    case E_INVALIDARG:                     return "E_INVALIDARG - params rejected (often an unsupported build)";
    case E_ACCESSDENIED:                   return "E_ACCESSDENIED - permission or target process out of reach";
    case AUDCLNT_E_DEVICE_INVALIDATED:     return "AUDCLNT_E_DEVICE_INVALIDATED";
    case AUDCLNT_E_UNSUPPORTED_FORMAT:     return "AUDCLNT_E_UNSUPPORTED_FORMAT";
    case AUDCLNT_E_ENDPOINT_CREATE_FAILED: return "AUDCLNT_E_ENDPOINT_CREATE_FAILED";
    default:                               return "(see HRESULT)";
  }
}

// ActivateAudioInterfaceAsync is asynchronous even though everything we do with
// it here is not, so the handler just parks the result and signals an event.
class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_UNEXPECTED;
  ComPtr<IAudioClient> client;

  STDMETHODIMP ActivateCompleted(
      IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activate_hr = E_UNEXPECTED;
    ComPtr<IUnknown> activated;
    HRESULT hr = operation->GetActivateResult(&activate_hr, &activated);

    result = SUCCEEDED(hr) ? activate_hr : hr;
    if (SUCCEEDED(result) && activated) activated.As(&client);

    SetEvent(done);
    return S_OK;
  }
};

}  // namespace

int wmain(int argc, wchar_t** argv) {
  const DWORD target_pid =
      (argc > 1) ? static_cast<DWORD>(_wtoi(argv[1])) : GetCurrentProcessId();

  wprintf(L"Windows build : %lu\n", []() -> DWORD {
    // GetVersionEx lies without a manifest; the registry does not.
    HKEY key{};
    DWORD build = 0, size = sizeof(build);
    wchar_t text[32]{};
    DWORD text_size = sizeof(text);
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE,
                      L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0,
                      KEY_READ, &key) == ERROR_SUCCESS) {
      if (RegQueryValueExW(key, L"CurrentBuildNumber", nullptr, nullptr,
                           reinterpret_cast<LPBYTE>(text),
                           &text_size) == ERROR_SUCCESS) {
        build = static_cast<DWORD>(_wtoi(text));
      }
      RegCloseKey(key);
    }
    (void)size;
    return build;
  }());
  wprintf(L"Excluding PID : %lu (and its process tree)\n\n", target_pid);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    wprintf(L"CoInitializeEx failed: 0x%08lX\n", hr);
    return 1;
  }

  /* ---- step 1: activation ------------------------------------------- */

  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = target_pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activate_params{};
  activate_params.vt = VT_BLOB;
  activate_params.blob.cbSize = sizeof(params);
  activate_params.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto handler = Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;

  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                   __uuidof(IAudioClient), &activate_params,
                                   handler.Get(), &operation);
  if (FAILED(hr)) {
    wprintf(L"[1] ActivateAudioInterfaceAsync call failed: 0x%08lX  %hs\n", hr,
            Explain(hr));
    return 2;
  }

  if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) {
    wprintf(L"[1] activation timed out after 5s\n");
    return 2;
  }
  if (FAILED(handler->result) || !handler->client) {
    wprintf(L"[1] activation REJECTED: 0x%08lX  %hs\n", handler->result,
            Explain(handler->result));
    wprintf(L"\nVERDICT: process loopback is not usable on this build.\n");
    return 2;
  }
  wprintf(L"[1] activation OK\n");

  /* ---- step 2: initialize ------------------------------------------- */

  // GetMixFormat is not supported on a process-loopback client, so the format
  // has to be stated outright. 48 kHz stereo 16-bit is what WebRTC wants anyway.
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

  hr = handler->client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
      2000000 /* 200ms in 100ns units */, 0, &format, nullptr);
  if (FAILED(hr)) {
    wprintf(L"[2] Initialize failed: 0x%08lX  %hs\n", hr, Explain(hr));
    wprintf(L"\nVERDICT: activation works but the client cannot be set up.\n");
    return 3;
  }
  wprintf(L"[2] Initialize OK (48kHz stereo 16-bit)\n");

  HANDLE buffer_ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = handler->client->SetEventHandle(buffer_ready);
  if (FAILED(hr)) {
    wprintf(L"[2] SetEventHandle failed: 0x%08lX\n", hr);
    return 3;
  }

  ComPtr<IAudioCaptureClient> capture;
  hr = handler->client->GetService(__uuidof(IAudioCaptureClient), &capture);
  if (FAILED(hr)) {
    wprintf(L"[2] GetService failed: 0x%08lX\n", hr);
    return 3;
  }

  /* ---- step 3: does anything actually arrive? ----------------------- */

  hr = handler->client->Start();
  if (FAILED(hr)) {
    wprintf(L"[3] Start failed: 0x%08lX\n", hr);
    return 4;
  }

  wprintf(L"\n[3] capturing for 5 seconds -- play something now...\n");

  const DWORD deadline = GetTickCount() + 5000;
  UINT64 total_frames = 0;
  UINT64 loud_frames = 0;
  INT16 peak = 0;

  while (GetTickCount() < deadline) {
    if (WaitForSingleObject(buffer_ready, 500) != WAIT_OBJECT_0) continue;

    UINT32 packet = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr)))
        break;

      total_frames += frames;
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data) {
        const INT16* samples = reinterpret_cast<const INT16*>(data);
        for (UINT32 i = 0; i < frames * format.nChannels; ++i) {
          INT16 value = samples[i] < 0 ? -samples[i] : samples[i];
          if (value > peak) peak = value;
        }
        if (peak > 64) loud_frames += frames;
      }
      capture->ReleaseBuffer(frames);
    }
  }

  handler->client->Stop();

  const double seconds = total_frames / 48000.0;
  wprintf(L"\n    frames captured : %llu (%.2f s of audio)\n", total_frames,
          seconds);
  wprintf(L"    non-silent      : %llu frames\n", loud_frames);
  wprintf(L"    peak amplitude  : %d / 32767\n\n", peak);

  if (total_frames == 0) {
    wprintf(L"VERDICT: the API works but delivered no audio at all.\n");
    return 4;
  }
  if (loud_frames == 0) {
    wprintf(
        L"VERDICT: audio arrives but it was all silence. Either nothing was\n"
        L"playing, or it was all coming from the excluded process tree.\n"
        L"Re-run with something playing from another app.\n");
    return 5;
  }

  wprintf(L"VERDICT: process loopback WORKS on this build. The addon is viable.\n");
  CoUninitialize();
  return 0;
}
