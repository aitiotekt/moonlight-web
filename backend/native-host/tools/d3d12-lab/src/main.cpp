/*
 * MoonlightWeb — native capture & encoding engine: D3D12 lab.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

// mw-d3d12-lab — measure before building (plan pipeline-video-d3d12-v2).
//
// One subcommand per question the D3D12 pipeline has to answer before any of
// it enters the engine. See tools/d3d12-lab/CMakeLists.txt for the why.

#include "Caps.h"
#include "Encode.h"
#include "Dda11on12.h"
#include "Interop.h"
#include "Queues.h"
#include "Scale.h"
#include "Wgc.h"
#include "Vendors.h"

#include <windows.h>
#include <wtsapi32.h>

#include <cstdio>
#include <string>
#include <vector>

namespace {

/// `--into-console --out <file>`: a probe started as SYSTEM in session 0 (a
/// scheduled task as SYSTEM) runs itself again in the console session, on the
/// same SYSTEM token with the session changed — as the worker service starts
/// the stream worker — its output in @p out. Session 0 has no compositor: a
/// capture asked there says nothing about the worker's own case (route B,
/// 21/10/2026: whether Windows.Graphics.Capture answers a SYSTEM worker).
int relaunchIntoConsole(const std::wstring& exe, const std::vector<std::wstring>& args,
                        const std::wstring& out)
{
    const DWORD session = ::WTSGetActiveConsoleSessionId();
    if (session == 0xFFFFFFFF) {
        std::puts("into-console: no console session");
        return 3;
    }
    HANDLE token = nullptr;
    if (!::OpenProcessToken(::GetCurrentProcess(),
                            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY |
                                TOKEN_ADJUST_SESSIONID | TOKEN_ADJUST_DEFAULT |
                                TOKEN_ADJUST_PRIVILEGES,
                            &token)) {
        std::printf("into-console: OpenProcessToken failed (%lu)\n", ::GetLastError());
        return 3;
    }
    // Changing a token's session needs SeTcbPrivilege, which SYSTEM holds
    // and may have to switch on.
    TOKEN_PRIVILEGES tcb = {};
    tcb.PrivilegeCount = 1;
    tcb.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    if (::LookupPrivilegeValueW(nullptr, SE_TCB_NAME, &tcb.Privileges[0].Luid))
        ::AdjustTokenPrivileges(token, FALSE, &tcb, 0, nullptr, nullptr);
    HANDLE primary = nullptr;
    if (!::DuplicateTokenEx(token, MAXIMUM_ALLOWED, nullptr, SecurityIdentification, TokenPrimary,
                            &primary)) {
        std::printf("into-console: DuplicateTokenEx failed (%lu)\n", ::GetLastError());
        ::CloseHandle(token);
        return 3;
    }
    ::CloseHandle(token);
    DWORD sessionId = session;
    if (!::SetTokenInformation(primary, TokenSessionId, &sessionId, sizeof(sessionId))) {
        std::printf("into-console: SetTokenInformation(TokenSessionId %lu) failed (%lu)\n", session,
                    ::GetLastError());
        ::CloseHandle(primary);
        return 3;
    }
    SECURITY_ATTRIBUTES inheritable = {sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE file = ::CreateFileW(out.c_str(), GENERIC_WRITE, FILE_SHARE_READ, &inheritable,
                                CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        std::printf("into-console: cannot create the output file (%lu)\n", ::GetLastError());
        ::CloseHandle(primary);
        return 3;
    }
    std::wstring cmd = L"\"" + exe + L"\"";
    for (const std::wstring& arg : args)
        cmd += arg.find(L' ') == std::wstring::npos ? L" " + arg : L" \"" + arg + L"\"";
    wchar_t desktop[] = L"winsta0\\default";
    STARTUPINFOW si = {};
    si.cb = sizeof(si);
    si.lpDesktop = desktop;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = file;
    si.hStdError = file;
    PROCESS_INFORMATION pi = {};
    const std::wstring cwd = exe.substr(0, exe.find_last_of(L"\\/"));
    const BOOL created = ::CreateProcessAsUserW(primary, exe.c_str(), cmd.data(), nullptr, nullptr,
                                                TRUE, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                                                nullptr, cwd.c_str(), &si, &pi);
    const DWORD createError = created ? 0 : ::GetLastError();
    ::CloseHandle(file);
    ::CloseHandle(primary);
    if (!created) {
        std::printf("into-console: CreateProcessAsUser failed (%lu)\n", createError);
        return 3;
    }
    ::CloseHandle(pi.hThread);
    std::printf("into-console: pid %lu in session %lu, waiting\n", pi.dwProcessId, session);
    ::WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    ::GetExitCodeProcess(pi.hProcess, &code);
    ::CloseHandle(pi.hProcess);
    std::printf("into-console: done, exit code %lu\n", code);
    return static_cast<int>(code);
}

void usage()
{
    std::puts(
        "mw-d3d12-lab <command> [options]\n"
        "  caps    what every GPU answers (driver, queues, fences, D3D12 Video Encode)\n"
        "  queues  where the conversion waits: D3D11, D3D12 DIRECT and COMPUTE, by priority,\n"
        "          and the driver's Video Process (Intel's SFC)\n"
        "  interop what the DDA handshake costs, and what reading without it does\n"
        "  dda11on12  Desktop Duplication on a D3D11On12 device carried by the chain's queue,\n"
        "          against the product's duplication and its fences (essai A, 21/10/2026)\n"
        "  wgc     Windows.Graphics.Capture in front of the D3D12 chain, by a shareable copy\n"
        "          or on a D3D11On12 device, against the duplication (route B, 21/10/2026)\n"
        "  encode  D3D12 Video Encode HEVC with the product's rate control\n"
        "  vendors NVENC and AMF fed D3D12 pictures\n"
        "  scale   the Lanczos-2 resample, timed, the product's way and three cheaper ones\n"
        "Run a command with --help for its options.\n"
        "  --into-console --out <file>  started as SYSTEM in session 0, run the command again\n"
        "          in the console session on the same token, the output in <file>\n");
}

} // namespace

int wmain(int argc, wchar_t** argv)
{
    ::SetConsoleOutputCP(CP_UTF8);
    // A driver that faults mid-probe takes the process down with what stdout
    // still holds (the N95's caps, 27/09): written as it comes, the last line
    // says where it stopped. The CRT has no line buffering, hence none at all.
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    ::SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    // `--into-console --out <file>` taken off the line before the command sees
    // it; in the console session already (or below SYSTEM), it is just dropped.
    std::vector<wchar_t*> kept;
    std::wstring out;
    bool intoConsole = false;
    for (int i = 0; i < argc; ++i) {
        const std::wstring arg = argv[i];
        if (arg == L"--into-console") {
            intoConsole = true;
        } else if (arg == L"--out" && i + 1 < argc) {
            out = argv[++i];
        } else {
            kept.push_back(argv[i]);
        }
    }
    bool impersonate = false;
    for (size_t i = 0; i < kept.size(); ++i) {
        if (std::wstring(kept[i]) == L"--impersonate") {
            impersonate = true;
            kept.erase(kept.begin() + static_cast<std::ptrdiff_t>(i));
            break;
        }
    }
    if (intoConsole) {
        DWORD session = 0;
        ::ProcessIdToSessionId(::GetCurrentProcessId(), &session);
        if (session == 0 && !out.empty()) {
            wchar_t exe[MAX_PATH] = {};
            ::GetModuleFileNameW(nullptr, exe, MAX_PATH);
            std::vector<std::wstring> args(kept.begin() + 1, kept.end());
            if (impersonate) args.insert(args.begin(), L"--impersonate");
            return relaunchIntoConsole(exe, args, out);
        }
        std::printf("into-console: already in session %lu, running here\n", session);
    }
    // `--impersonate`: the thread takes the console user's token before any
    // capture call — whether Windows.Graphics.Capture, which answers a SYSTEM
    // caller "no such service" (0x80070424: its per-user CaptureService has
    // no instance for SYSTEM), answers the user from inside a SYSTEM process.
    if (impersonate) {
        HANDLE user = nullptr;
        if (!::WTSQueryUserToken(::WTSGetActiveConsoleSessionId(), &user)) {
            std::printf("impersonate: WTSQueryUserToken failed (%lu)\n", ::GetLastError());
        } else if (!::ImpersonateLoggedOnUser(user)) {
            std::printf("impersonate: ImpersonateLoggedOnUser failed (%lu)\n", ::GetLastError());
        } else {
            std::puts("impersonate: this thread runs as the console user");
        }
        if (user) ::CloseHandle(user);
    }
    argc = static_cast<int>(kept.size());
    argv = kept.data();
    if (argc < 2) {
        usage();
        return 2;
    }
    const std::wstring command = argv[1];
    const bool help = argc >= 3 && std::wstring(argv[2]) == L"--help";
    if (command == L"caps") {
        if (help) {
            lab::capsUsage();
            return 0;
        }
        return lab::runCaps(argc - 2, argv + 2);
    }
    if (command == L"queues") {
        if (help) {
            lab::queuesUsage();
            return 0;
        }
        return lab::runQueues(argc - 2, argv + 2);
    }
    if (command == L"interop") {
        if (help) {
            lab::interopUsage();
            return 0;
        }
        return lab::runInterop(argc - 2, argv + 2);
    }
    if (command == L"dda11on12") {
        if (help) {
            lab::dda11on12Usage();
            return 0;
        }
        return lab::runDda11on12(argc - 2, argv + 2);
    }
    if (command == L"wgc") {
        if (help) {
            lab::wgcUsage();
            return 0;
        }
        return lab::runWgc(argc - 2, argv + 2);
    }
    if (command == L"encode") {
        if (help) {
            lab::encodeUsage();
            return 0;
        }
        return lab::runEncode(argc - 2, argv + 2);
    }
    if (command == L"vendors") {
        if (help) {
            lab::vendorsUsage();
            return 0;
        }
        return lab::runVendors(argc - 2, argv + 2);
    }
    if (command == L"scale") {
        if (help) {
            lab::scaleUsage();
            return 0;
        }
        return lab::runScale(argc - 2, argv + 2);
    }
    usage();
    return command == L"--help" ? 0 : 2;
}
