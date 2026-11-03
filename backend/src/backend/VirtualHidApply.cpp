/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
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

#include "backend/VirtualHidApply.h"

#include "backend/VirtualDisplay.h"
#include "common/Logger.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>

#include <cstdio>

#ifdef Q_OS_WIN
#include <setupapi.h>
#include <newdev.h>
#include <devguid.h>
#include <cfgmgr32.h>
#endif

namespace VirtualHidApply {

QString bundledDriverDir()
{
    return QCoreApplication::applicationDirPath() + QStringLiteral("/drivers/vhid");
}

namespace {

constexpr int kExitOk = 0;
constexpr int kExitFailed = 1;
constexpr int kExitReboot = 3010; // ERROR_SUCCESS_REBOOT_REQUIRED, like a driver installer

int answer(const QString& action, bool ok, const QString& detail, bool reboot = false)
{
    QJsonObject o{{QStringLiteral("action"), action}, {QStringLiteral("ok"), ok}};
    if (!detail.isEmpty()) o[ok ? QStringLiteral("note") : QStringLiteral("error")] = detail;
    if (reboot) o[QStringLiteral("rebootRequired")] = true;
    std::fputs(QJsonDocument(o).toJson(QJsonDocument::Compact).constData(), stdout);
    std::fputs("\n", stdout);
    std::fflush(stdout);
    if (ok)
        Logger::info(QStringLiteral("[vhid-apply] %1: %2")
                         .arg(action, detail.isEmpty() ? QStringLiteral("done") : detail));
    else
        Logger::warning(QStringLiteral("[vhid-apply] %1 failed: %2").arg(action, detail));
    return !ok ? kExitFailed : reboot ? kExitReboot : kExitOk;
}

#ifdef Q_OS_WIN

QString lastErrorText(DWORD err = GetLastError())
{
    wchar_t* buf = nullptr;
    const DWORD n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
                                       FORMAT_MESSAGE_IGNORE_INSERTS,
                                   nullptr, err, 0, reinterpret_cast<LPWSTR>(&buf), 0, nullptr);
    QString text = n ? QString::fromWCharArray(buf, int(n)).trimmed() : QString();
    if (buf) LocalFree(buf);
    return QStringLiteral("0x%1 %2").arg(err, 8, 16, QLatin1Char('0')).arg(text);
}

// ── The editions that use the driver ────────────────────────────────────────
//
// MoonlightWeb and MoonlightWebDev install side by side and share the one
// node: the hardware id is the driver's, not an edition's. Each records itself
// here on install; uninstalling one removes the driver only when no other is
// left, or the DEV's uninstaller would pull the wheel from under the
// production app. An edition that never recorded itself removes nothing: a
// bench machine's driver put there by hand (drivers/vhid/install.ps1) is no
// edition's to take away.

const wchar_t* const kOwnersKey = L"SOFTWARE\\MoonlightWebVHid\\Owners";

QString thisEdition()
{
    return QFileInfo(QCoreApplication::applicationFilePath()).completeBaseName();
}

void addOwner()
{
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, kOwnersKey, 0, nullptr, 0,
                        KEY_SET_VALUE | KEY_WOW64_64KEY, nullptr, &key, nullptr) != ERROR_SUCCESS)
        return;
    const std::wstring name = thisEdition().toStdWString();
    const DWORD one = 1;
    RegSetValueExW(key, name.c_str(), 0, REG_DWORD, reinterpret_cast<const BYTE*>(&one),
                   sizeof(one));
    RegCloseKey(key);
}

/// Forget this edition: whether it was recorded at all, and how many are still
/// recorded after it.
bool removeOwner(int* remaining)
{
    *remaining = 0;
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, kOwnersKey, 0,
                      KEY_SET_VALUE | KEY_QUERY_VALUE | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS)
        return false;
    const std::wstring name = thisEdition().toStdWString();
    const bool wasOwner = RegDeleteValueW(key, name.c_str()) == ERROR_SUCCESS;
    DWORD values = 0;
    RegQueryInfoKeyW(key, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &values, nullptr,
                     nullptr, nullptr, nullptr);
    RegCloseKey(key);
    if (values == 0) RegDeleteKeyExW(HKEY_LOCAL_MACHINE, kOwnersKey, KEY_WOW64_64KEY, 0);
    *remaining = int(values);
    return wasOwner;
}

// ── Our nodes ───────────────────────────────────────────────────────────────

/// Every root-enumerated node, present or not, whatever its class: a node an
/// interrupted install left without a driver has no class yet, and has to be
/// found all the same (install.ps1 learnt it on the bench).
struct RootNodes
{
    HDEVINFO set = INVALID_HANDLE_VALUE;

    RootNodes()
        : set(SetupDiGetClassDevsW(nullptr, L"ROOT", nullptr, DIGCF_ALLCLASSES))
    {}
    ~RootNodes()
    {
        if (set != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(set);
    }
    RootNodes(const RootNodes&) = delete;
    RootNodes& operator=(const RootNodes&) = delete;
    bool valid() const { return set != INVALID_HANDLE_VALUE; }

    bool isOurs(SP_DEVINFO_DATA& data) const
    {
        DWORD size = 0;
        SetupDiGetDeviceRegistryPropertyW(set, &data, SPDRP_HARDWAREID, nullptr, nullptr, 0, &size);
        if (size == 0) return false;
        std::vector<wchar_t> ids(size / sizeof(wchar_t) + 1, 0);
        if (!SetupDiGetDeviceRegistryPropertyW(set, &data, SPDRP_HARDWAREID, nullptr,
                                               reinterpret_cast<BYTE*>(ids.data()), size, nullptr))
            return false;
        for (const wchar_t* h = ids.data(); *h; h += wcslen(h) + 1)
            if (QString::fromWCharArray(h).compare(hardwareId(), Qt::CaseInsensitive) == 0)
                return true;
        return false;
    }

    std::vector<SP_DEVINFO_DATA> ours() const
    {
        std::vector<SP_DEVINFO_DATA> out;
        SP_DEVINFO_DATA data{};
        data.cbSize = sizeof(data);
        for (DWORD i = 0; SetupDiEnumDeviceInfo(set, i, &data); ++i)
            if (isOurs(data)) out.push_back(data);
        return out;
    }
};

bool setFriendlyName(HDEVINFO set, SP_DEVINFO_DATA& data, QString* error)
{
    const std::wstring name = deviceName().toStdWString();
    if (!SetupDiSetDeviceRegistryPropertyW(set, &data, SPDRP_FRIENDLYNAME,
                                           reinterpret_cast<const BYTE*>(name.c_str()),
                                           DWORD((name.size() + 1) * sizeof(wchar_t)))) {
        *error = QStringLiteral("SetupDiSetDeviceRegistryProperty(friendly name): %1")
                     .arg(lastErrorText());
        return false;
    }
    return true;
}

bool createNode(HDEVINFO set, SP_DEVINFO_DATA& data, QString* error)
{
    data = SP_DEVINFO_DATA{};
    data.cbSize = sizeof(data);
    if (!SetupDiCreateDeviceInfoW(set, L"System", &GUID_DEVCLASS_SYSTEM, nullptr, nullptr,
                                  DICD_GENERATE_ID, &data)) {
        *error = QStringLiteral("SetupDiCreateDeviceInfo: %1").arg(lastErrorText());
        return false;
    }
    // A REG_MULTI_SZ: the id, then two terminators.
    std::wstring hw = hardwareId().toStdWString();
    std::vector<wchar_t> multi(hw.begin(), hw.end());
    multi.push_back(0);
    multi.push_back(0);
    if (!SetupDiSetDeviceRegistryPropertyW(set, &data, SPDRP_HARDWAREID,
                                           reinterpret_cast<const BYTE*>(multi.data()),
                                           DWORD(multi.size() * sizeof(wchar_t)))) {
        *error = QStringLiteral("SetupDiSetDeviceRegistryProperty(hardware id): %1")
                     .arg(lastErrorText());
        return false;
    }
    if (!setFriendlyName(set, data, error)) return false;
    if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set, &data)) {
        *error = QStringLiteral("DIF_REGISTERDEVICE: %1").arg(lastErrorText());
        return false;
    }
    return true;
}

bool removeNode(HDEVINFO set, SP_DEVINFO_DATA& data, QString* error)
{
    SP_REMOVEDEVICE_PARAMS params{};
    params.ClassInstallHeader.cbSize = sizeof(SP_CLASSINSTALL_HEADER);
    params.ClassInstallHeader.InstallFunction = DIF_REMOVE;
    params.Scope = DI_REMOVEDEVICE_GLOBAL;
    if (!SetupDiSetClassInstallParamsW(set, &data, &params.ClassInstallHeader, sizeof(params)) ||
        !SetupDiCallClassInstaller(DIF_REMOVE, set, &data)) {
        *error = QStringLiteral("DIF_REMOVE: %1").arg(lastErrorText());
        return false;
    }
    return true;
}

/// Stage the package in the driver store and install it on our node. With no
/// driver named, DiInstallDevice takes the best-ranked package in the store
/// for the node: the one just staged, or a newer one already there.
bool installOnNode(HDEVINFO set, SP_DEVINFO_DATA& data, const QString& infPath, bool* reboot,
                   QString* error)
{
    const std::wstring inf = QDir::toNativeSeparators(infPath).toStdWString();
    if (!SetupCopyOEMInfW(inf.c_str(), nullptr, SPOST_PATH, 0, nullptr, 0, nullptr, nullptr)) {
        *error = QStringLiteral("SetupCopyOEMInf: %1").arg(lastErrorText());
        return false;
    }
    BOOL needReboot = FALSE;
    if (!DiInstallDevice(nullptr, set, &data, nullptr, 0, &needReboot)) {
        *error = QStringLiteral("DiInstallDevice: %1").arg(lastErrorText());
        return false;
    }
    *reboot = needReboot != FALSE;
    return true;
}

/// The node's driver is this very package: the pinned files, found again in
/// the driver store folder its INF was installed from. Reinstalling it would
/// restart the node for nothing, and a game still holding a wheel made through
/// it turns that restart into a reboot (exit 3010 on every update of the bench
/// of 11/10, with ACC open).
bool nodeHasPackage(HDEVINFO set, SP_DEVINFO_DATA& data,
                    const std::vector<DriverPackage::File>& files)
{
    HKEY key = SetupDiOpenDevRegKey(set, &data, DICS_FLAG_GLOBAL, 0, DIREG_DRV, KEY_QUERY_VALUE);
    if (key == INVALID_HANDLE_VALUE) return false; // no driver yet
    wchar_t inf[MAX_PATH] = {};
    DWORD bytes = sizeof(inf) - sizeof(wchar_t);
    const bool hasInf = RegQueryValueExW(key, L"InfPath", nullptr, nullptr,
                                         reinterpret_cast<BYTE*>(inf), &bytes) == ERROR_SUCCESS;
    RegCloseKey(key);
    if (!hasInf || inf[0] == 0) return false;
    wchar_t stored[MAX_PATH] = {};
    if (!SetupGetInfDriverStoreLocationW(inf, nullptr, nullptr, stored, MAX_PATH, nullptr))
        return false;
    const QString dir = QFileInfo(QString::fromWCharArray(stored)).absolutePath();
    QString infPath, catPath;
    return DriverPackage::checkFiles(dir, files.data(), files.size(), &infPath, &catPath).isEmpty();
}

/// Windows still has to restart for the node's driver: an update earlier
/// found a device made through the old one held open.
bool restartPending(const SP_DEVINFO_DATA& data)
{
    ULONG status = 0, problem = 0;
    if (CM_Get_DevNode_Status(&status, &problem, data.DevInst, 0) != CR_SUCCESS) return false;
    return (status & DN_NEED_RESTART) || problem == CM_PROB_NEED_RESTART;
}

/// Every package in the store that installs on our hardware id, deleted. Best
/// effort: a package left behind is harmless once the node is gone. A test
/// package from install.ps1 goes too, which is what an uninstall should do.
void deletePackages()
{
    HDEVINFO set = SetupDiCreateDeviceInfoList(&GUID_DEVCLASS_SYSTEM, nullptr);
    if (set == INVALID_HANDLE_VALUE) return;
    if (SetupDiBuildDriverInfoList(set, nullptr, SPDIT_CLASSDRIVER)) {
        SP_DRVINFO_DATA_W drv{};
        drv.cbSize = sizeof(drv);
        for (DWORD i = 0; SetupDiEnumDriverInfoW(set, nullptr, SPDIT_CLASSDRIVER, i, &drv); ++i) {
            DWORD need = 0;
            SetupDiGetDriverInfoDetailW(set, nullptr, &drv, nullptr, 0, &need);
            if (need == 0) continue;
            std::vector<BYTE> buf(need);
            auto* detail = reinterpret_cast<PSP_DRVINFO_DETAIL_DATA_W>(buf.data());
            detail->cbSize = sizeof(SP_DRVINFO_DETAIL_DATA_W);
            if (!SetupDiGetDriverInfoDetailW(set, nullptr, &drv, detail, need, nullptr)) continue;
            // HardwareID is the multi-sz of ids this driver entry matches; ours
            // is the only one the INF lists.
            if (QString::fromWCharArray(detail->HardwareID)
                    .compare(hardwareId(), Qt::CaseInsensitive) != 0)
                continue;
            const QString infName =
                QFileInfo(QString::fromWCharArray(detail->InfFileName)).fileName();
            if (!infName.startsWith(QLatin1String("oem"), Qt::CaseInsensitive)) continue;
            const std::wstring w = infName.toStdWString();
            if (SetupUninstallOEMInfW(w.c_str(), SUOI_FORCEDELETE, nullptr))
                Logger::info(QStringLiteral("[vhid-apply] driver package %1 deleted").arg(infName));
            else
                Logger::warning(QStringLiteral("[vhid-apply] SetupUninstallOEMInf(%1): %2")
                                    .arg(infName, lastErrorText()));
        }
        SetupDiDestroyDriverInfoList(set, nullptr, SPDIT_CLASSDRIVER);
    }
    SetupDiDestroyDeviceInfoList(set);
}

int install(const QString& action, const QString& dir)
{
    const std::vector<DriverPackage::File>& files = driverFiles();
    if (files.empty() || catalogSignerThumbprint().isEmpty())
        return answer(action, true, QStringLiteral("skipped: this build pins no signed package"));
    if (!QFileInfo::exists(dir + QStringLiteral("/MoonlightWebVHid.inf")))
        return answer(action, true, QStringLiteral("skipped: no package under %1").arg(dir));

    // The files as the installer laid them out, re-hashed against the
    // constants compiled into THIS exe before SetupAPI sees them.
    QString infPath, catPath;
    QString error = DriverPackage::checkFiles(dir, files.data(), files.size(), &infPath, &catPath);
    if (!error.isEmpty()) return answer(action, false, error);
    if (infPath.isEmpty() || catPath.isEmpty())
        return answer(action, false, QStringLiteral("the pinned package has no .inf or no .cat"));

    RootNodes nodes;
    if (!nodes.valid())
        return answer(action, false,
                      QStringLiteral("SetupDiGetClassDevs: %1").arg(lastErrorText()));

    std::vector<SP_DEVINFO_DATA> ours = nodes.ours();
    const bool created = ours.empty();
    SP_DEVINFO_DATA data{};
    if (!created) {
        // One node is the design; a second one (an older bench install) is
        // left alone rather than guessed about.
        data = ours.front();
        if (nodeHasPackage(nodes.set, data, files)) {
            addOwner();
            const bool pending = restartPending(data);
            return answer(action, true,
                          pending ? QStringLiteral("up to date, loaded when Windows restarts")
                                  : QStringLiteral("up to date"),
                          pending);
        }
    }

    // Our own certificate: in Root and Trusted Publishers for the install, out
    // of both before this returns. The driver, once installed, loads without.
    DriverPackage::PublisherTrust trust;
    if (!DriverPackage::trustCatalogSigner(catPath, catalogSignerThumbprint(), true, "[vhid-apply]",
                                           trust, &error))
        return answer(action, false, error);

    if (created && !createNode(nodes.set, data, &error)) return answer(action, false, error);
    bool reboot = false;
    if (!installOnNode(nodes.set, data, infPath, &reboot, &error)) {
        // Leave no orphan node behind a failed first install.
        if (created) {
            QString ignored;
            removeNode(nodes.set, data, &ignored);
        }
        return answer(action, false, error);
    }
    // Installing the package rewrites the description from the INF; the name
    // set after it is the one that lasts (as measured with the virtual
    // display's node).
    if (!setFriendlyName(nodes.set, data, &error))
        Logger::warning(QStringLiteral("[vhid-apply] %1").arg(error));
    addOwner();
    // Reboot: a game still holds a device made through the old driver, which
    // stays loaded until Windows restarts. The engine copes with either.
    return answer(action, true,
                  created  ? QStringLiteral("installed")
                  : reboot ? QStringLiteral("updated, loaded when Windows restarts")
                           : QStringLiteral("updated"),
                  reboot);
}

int uninstall(const QString& action)
{
    int others = 0;
    if (!removeOwner(&others))
        return answer(action, true, QStringLiteral("skipped: not installed by this edition"));
    if (others > 0)
        return answer(action, true,
                      QStringLiteral("kept: %1 other edition(s) still use it").arg(others));

    RootNodes nodes;
    if (!nodes.valid())
        return answer(action, false,
                      QStringLiteral("SetupDiGetClassDevs: %1").arg(lastErrorText()));
    QString error;
    bool ok = true;
    for (SP_DEVINFO_DATA data : nodes.ours()) {
        if (!removeNode(nodes.set, data, &error)) ok = false;
    }
    deletePackages();
    return answer(action, ok, ok ? QStringLiteral("removed") : error);
}

#endif

} // namespace

int run(const QString& action, const QString& dirArg)
{
    if (action != QLatin1String("install") && action != QLatin1String("uninstall"))
        return answer(action, false, QStringLiteral("unknown action (install|uninstall)"));
#ifdef Q_OS_WIN
    if (!VirtualDisplay::processElevated())
        return answer(action, false, QStringLiteral("this process is not elevated"));
    const QString dir = dirArg.isEmpty() ? bundledDriverDir() : dirArg;
    return action == QLatin1String("install") ? install(action, dir) : uninstall(action);
#else
    Q_UNUSED(dirArg);
    return answer(action, true, QStringLiteral("skipped: Windows only"));
#endif
}

} // namespace VirtualHidApply
