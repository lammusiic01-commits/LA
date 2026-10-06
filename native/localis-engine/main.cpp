#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <filesystem>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

namespace fs = std::filesystem;

static std::wstring quoteArgument(const std::wstring& value) {
  std::wstring out = L"\"";
  size_t backslashes = 0;
  for (wchar_t ch : value) {
    if (ch == L'\\') {
      ++backslashes;
    } else if (ch == L'\"') {
      out.append(backslashes * 2 + 1, L'\\');
      out.push_back(ch);
      backslashes = 0;
    } else {
      out.append(backslashes, L'\\');
      out.push_back(ch);
      backslashes = 0;
    }
  }
  out.append(backslashes * 2, L'\\');
  out.push_back(L'\"');
  return out;
}

static std::wstring readArgument(int argc, wchar_t** argv, const std::wstring& key) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (argv[i] == key) return argv[i + 1];
  }
  return L"";
}

static std::optional<std::wstring> findNvidiaSmi() {
  wchar_t found[MAX_PATH]{};
  if (SearchPathW(nullptr, L"nvidia-smi.exe", nullptr, MAX_PATH, found, nullptr) > 0) return std::wstring(found);

  wchar_t programFiles[MAX_PATH]{};
  const DWORD length = GetEnvironmentVariableW(L"ProgramFiles", programFiles, MAX_PATH);
  if (length > 0 && length < MAX_PATH) {
    const fs::path candidate = fs::path(programFiles) / L"NVIDIA Corporation" / L"NVSMI" / L"nvidia-smi.exe";
    if (fs::exists(candidate)) return candidate.wstring();
  }
  return std::nullopt;
}

static unsigned queryNvidiaMemoryMiB() {
  const auto nvidiaSmi = findNvidiaSmi();
  if (!nvidiaSmi) return 0;

  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE readPipe = nullptr;
  HANDLE writePipe = nullptr;
  if (!CreatePipe(&readPipe, &writePipe, &security, 0)) return 0;
  SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = writePipe;
  startup.hStdError = writePipe;
  PROCESS_INFORMATION process{};
  std::wstring command = quoteArgument(*nvidiaSmi) + L" --query-gpu=memory.total --format=csv,noheader,nounits";
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(L'\0');

  const BOOL started = CreateProcessW(nvidiaSmi->c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, nullptr, nullptr, &startup, &process);
  CloseHandle(writePipe);
  if (!started) {
    CloseHandle(readPipe);
    return 0;
  }

  std::string output;
  char buffer[128];
  DWORD bytesRead = 0;
  while (ReadFile(readPipe, buffer, sizeof(buffer) - 1, &bytesRead, nullptr) && bytesRead > 0 && output.size() < 1024) {
    output.append(buffer, bytesRead);
  }
  CloseHandle(readPipe);
  const DWORD finished = WaitForSingleObject(process.hProcess, 5000);
  if (finished == WAIT_TIMEOUT) TerminateProcess(process.hProcess, 1);
  DWORD exitCode = 1;
  GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (finished != WAIT_OBJECT_0 || exitCode != 0) return 0;

  try {
    const unsigned long value = std::stoul(output);
    return static_cast<unsigned>(std::min<unsigned long>(value, 1'000'000UL));
  } catch (...) {
    return 0;
  }
}

static unsigned hardwareThreads() {
  const DWORD logical = GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
  if (!logical) return 4;
  // Leave logical processors for the renderer, browser, file tools and Windows.
  return std::clamp<unsigned>(logical > 2 ? logical - 4 : logical, 2, 8);
}

static unsigned totalMemoryGiB() {
  MEMORYSTATUSEX status{};
  status.dwLength = sizeof(status);
  if (!GlobalMemoryStatusEx(&status)) return 0;
  return static_cast<unsigned>(status.ullTotalPhys / (1024ULL * 1024ULL * 1024ULL));
}

static void terminateChild(HANDLE job, HANDLE process) {
  if (job) CloseHandle(job); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE stops llama-server.
  if (process) CloseHandle(process);
}

int wmain(int argc, wchar_t** argv) {
  const std::wstring runtimeArg = readArgument(argc, argv, L"--runtime");
  const std::wstring modelArg = readArgument(argc, argv, L"--model");
  const std::wstring portArg = readArgument(argc, argv, L"--port");
  if (runtimeArg.empty() || modelArg.empty() || portArg.empty()) {
    std::wcerr << L"Localis Engine usage: localis-engine.exe --runtime <llama-server.exe> --model <model.gguf> --port <port>\n";
    return 2;
  }

  unsigned port = 0;
  try { port = static_cast<unsigned>(std::stoul(portArg)); }
  catch (...) { std::wcerr << L"Invalid server port.\n"; return 2; }
  if (port < 1024 || port > 65535) { std::wcerr << L"Server port must be between 1024 and 65535.\n"; return 2; }

  std::error_code error;
  const fs::path runtime = fs::absolute(runtimeArg, error);
  if (error || !fs::is_regular_file(runtime)) { std::wcerr << L"Bundled llama-server executable was not found.\n"; return 3; }
  const fs::path model = fs::absolute(modelArg, error);
  if (error || !fs::is_regular_file(model)) { std::wcerr << L"Bundled GGUF model was not found.\n"; return 3; }

  const unsigned vramMiB = queryNvidiaMemoryMiB();
  const unsigned ramGiB = totalMemoryGiB();
  const unsigned threads = hardwareThreads();
  const unsigned context = (ramGiB >= 14 && vramMiB >= 6000) ? 8192 : 4096;
  const unsigned gpuLayers = vramMiB >= 6000 ? 99 : (vramMiB >= 3500 ? 24 : 0);
  const unsigned batchThreads = std::min(threads + 2, 10U);

  std::wstring command = quoteArgument(runtime.wstring()) +
    L" --model " + quoteArgument(model.wstring()) +
    L" --host 127.0.0.1 --port " + std::to_wstring(port) +
    L" --ctx-size " + std::to_wstring(context) +
    L" --alias lam-v1.0 --n-gpu-layers " + std::to_wstring(gpuLayers) +
    L" --threads " + std::to_wstring(threads) +
    L" --threads-batch " + std::to_wstring(batchThreads) +
    L" --batch-size 512 --ubatch-size 256 --parallel 1 --jinja";
  if (gpuLayers > 0) {
    command += L" --flash-attn auto --cache-type-k q8_0 --cache-type-v q8_0";
  }

  std::wcout << L"LamV1.0 launcher: RAM=" << ramGiB << L" GiB, NVIDIA VRAM=" << vramMiB
    << L" MiB, context=" << context << L", GPU layers=" << gpuLayers << L", CPU threads=" << threads << L"\n";

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) { std::wcerr << L"Could not create the inference process job.\n"; return 4; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo{};
  jobInfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jobInfo, sizeof(jobInfo))) {
    CloseHandle(job);
    std::wcerr << L"Could not configure the inference process job.\n";
    return 4;
  }

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process{};
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(L'\0');
  const std::wstring workingDirectory = runtime.parent_path().wstring();

  const BOOL started = CreateProcessW(runtime.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, nullptr, workingDirectory.c_str(), &startup, &process);
  if (!started) {
    const DWORD lastError = GetLastError();
    CloseHandle(job);
    std::wcerr << L"Could not start llama-server (Windows error " << lastError << L").\n";
    return 5;
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    const DWORD lastError = GetLastError();
    TerminateProcess(process.hProcess, 5);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    std::wcerr << L"Could not attach llama-server to the managed process group (Windows error " << lastError << L").\n";
    return 6;
  }
  CloseHandle(process.hThread);

  const DWORD finished = WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = 1;
  if (finished == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &exitCode);
  terminateChild(job, process.hProcess);
  return finished == WAIT_OBJECT_0 ? static_cast<int>(exitCode) : 7;
}
