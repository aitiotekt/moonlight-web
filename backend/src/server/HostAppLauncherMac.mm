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

#include "HostAppLauncher.h"

#include "common/Logger.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QHash>
#include <QTimer>

#include <memory>

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

namespace HostAppLauncher {

namespace {

// How long the windows the app opens are watched for, and how often. Steam
// already running shows Big Picture within a second or two; a cold start
// takes longer, and its windows are new all the same.
constexpr int kWatchMs = 15000;
constexpr int kTickMs = 250;

/// The bundle id of the app @p command opens: the URL's handler, or the .app
/// itself. Empty for a shell command — nothing to follow then.
QString bundleIdFor(const QString& command)
{
    @autoreleasepool {
        const QString line = command.trimmed();
        NSURL* app = nil;
        if (isUrl(line)) {
            NSURL* url = [NSURL URLWithString:line.toNSString()];
            if (url) app = [[NSWorkspace sharedWorkspace] URLForApplicationToOpenURL:url];
        } else if (line.endsWith(QStringLiteral(".app"))) {
            app = [NSURL fileURLWithPath:line.toNSString()];
        }
        if (!app) return {};
        NSString* id = [[NSBundle bundleWithURL:app] bundleIdentifier];
        return id ? QString::fromNSString(id) : QString();
    }
}

/// The processes of that app, its helpers included ("com.valvesoftware.steam"
/// and "….steam.helper"): which of them owns a window is the app's business.
QSet<pid_t> processesOf(const QString& bundleId)
{
    QSet<pid_t> out;
    @autoreleasepool {
        const QString helpers = bundleId + QLatin1Char('.');
        for (NSRunningApplication* app in [[NSWorkspace sharedWorkspace] runningApplications]) {
            if (!app.bundleIdentifier) continue;
            const QString id = QString::fromNSString(app.bundleIdentifier);
            if (id == bundleId || id.startsWith(helpers)) out.insert(app.processIdentifier);
        }
    }
    return out;
}

/// The ordinary windows (layer 0) those processes show, with their owner.
QList<SeenWindow> windowsOf(const QSet<pid_t>& pids, QHash<int, pid_t>* owners)
{
    QList<SeenWindow> out;
    if (pids.isEmpty()) return out;
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!list) return out;
    for (CFIndex i = 0; i < CFArrayGetCount(list); ++i) {
        auto info = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(list, i));
        int pid = 0, layer = 0, number = 0;
        auto num = [&](CFStringRef key, int* value) {
            auto n = static_cast<CFNumberRef>(CFDictionaryGetValue(info, key));
            return n && CFNumberGetValue(n, kCFNumberIntType, value);
        };
        if (!num(kCGWindowOwnerPID, &pid) || !pids.contains(pid)) continue;
        if (!num(kCGWindowLayer, &layer) || layer != 0) continue;
        if (!num(kCGWindowNumber, &number)) continue;
        CGRect rect;
        auto bounds = static_cast<CFDictionaryRef>(CFDictionaryGetValue(info, kCGWindowBounds));
        if (!bounds || !CGRectMakeWithDictionaryRepresentation(bounds, &rect)) continue;
        out.append({number, QRect(int(rect.origin.x), int(rect.origin.y), int(rect.size.width),
                                  int(rect.size.height))});
        if (owners) owners->insert(number, pid_t(pid));
    }
    CFRelease(list);
    return out;
}

// Leaving full screen is animated: the window reports a settable position
// at once, yet a move sent before the animation is over is lost (seen on
// the Mac bench with Big Picture). This long after asking, it lands.
constexpr qint64 kLeaveFullScreenMs = 1200;

enum class Step
{
    Moved,
    LeavingFullScreen, ///< asked to leave full screen: moved on a later tick
    NotYet,            ///< not found where the window server shows it, or animating
    Failed,
};

bool fullScreen(AXUIElementRef window)
{
    CFTypeRef value = nullptr;
    if (AXUIElementCopyAttributeValue(window, CFSTR("AXFullScreen"), &value) != kAXErrorSuccess ||
        !value)
        return false;
    const bool on = CFGetTypeID(value) == CFBooleanGetTypeID() &&
                    CFBooleanGetValue(static_cast<CFBooleanRef>(value));
    CFRelease(value);
    return on;
}

/// One step of moving the window of @p pid that sits at @p from onto @p to,
/// by the Accessibility API — the one way to move another app's window. The
/// window server's id is not exposed there, so the window is the one at that
/// place. A window in full screen (Steam's Big Picture is, in its own Space)
/// cannot be moved: it is taken out of it first, moved once the animation is
/// over, and put back in full screen there (@p wasFullScreen).
Step stepWindow(pid_t pid, const QRect& from, const QRect& to, bool wasFullScreen)
{
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) return Step::Failed;
    // An app busy starting up must not hold the server's event loop.
    AXUIElementSetMessagingTimeout(app, 0.5f);
    Step step = Step::NotYet;
    CFArrayRef windows = nullptr;
    if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute,
                                      reinterpret_cast<CFTypeRef*>(&windows)) == kAXErrorSuccess &&
        windows) {
        for (CFIndex i = 0; i < CFArrayGetCount(windows) && step == Step::NotYet; ++i) {
            auto window = static_cast<AXUIElementRef>(CFArrayGetValueAtIndex(windows, i));
            CGPoint at{};
            CGSize size{};
            CFTypeRef value = nullptr;
            if (AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &value) !=
                    kAXErrorSuccess ||
                !value)
                continue;
            AXValueGetValue(static_cast<AXValueRef>(value), kAXValueTypeCGPoint, &at);
            CFRelease(value);
            value = nullptr;
            if (AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &value) !=
                    kAXErrorSuccess ||
                !value)
                continue;
            AXValueGetValue(static_cast<AXValueRef>(value), kAXValueTypeCGSize, &size);
            CFRelease(value);
            if (qAbs(int(at.x) - from.x()) > 2 || qAbs(int(at.y) - from.y()) > 2 ||
                qAbs(int(size.width) - from.width()) > 2 ||
                qAbs(int(size.height) - from.height()) > 2)
                continue;
            if (fullScreen(window)) {
                step = AXUIElementSetAttributeValue(window, CFSTR("AXFullScreen"),
                                                    kCFBooleanFalse) == kAXErrorSuccess
                           ? Step::LeavingFullScreen
                           : Step::Failed;
                continue;
            }
            // Onto the display first, then its size: a window the size of
            // the built-in screen does not fit the smaller virtual one, and
            // macOS keeps a window's top-left on a display when it resizes.
            CGPoint origin = CGPointMake(to.x(), to.y());
            CGSize fit = CGSizeMake(to.width(), to.height());
            AXValueRef pos = AXValueCreate(kAXValueTypeCGPoint, &origin);
            AXValueRef dim = AXValueCreate(kAXValueTypeCGSize, &fit);
            step =
                AXUIElementSetAttributeValue(window, kAXPositionAttribute, pos) == kAXErrorSuccess
                    ? Step::Moved
                    : Step::Failed;
            AXUIElementSetAttributeValue(window, kAXSizeAttribute, dim);
            AXUIElementSetAttributeValue(window, kAXPositionAttribute, pos);
            CFRelease(pos);
            CFRelease(dim);
            // Full screen again, on the display it now sits on.
            if (wasFullScreen)
                AXUIElementSetAttributeValue(window, CFSTR("AXFullScreen"), kCFBooleanTrue);
        }
        CFRelease(windows);
    }
    CFRelease(app);
    return step;
}

struct Watch
{
    QString bundleId;
    QSet<int> before; ///< its windows when it was opened: left where they are
    QSet<int> moved;
    QHash<int, qint64> leavingFullScreen; ///< window → when it was asked to (age)
    QElapsedTimer age;
};

void pullOnce(Watch& watch)
{
    QHash<int, pid_t> owners;
    const QList<SeenWindow> now = windowsOf(processesOf(watch.bundleId), &owners);
    // The virtual display is the main one while it shows a stream.
    const CGRect main = CGDisplayBounds(CGMainDisplayID());
    const QRect target(int(main.origin.x), int(main.origin.y), int(main.size.width),
                       int(main.size.height));
    // The windows on their way out of full screen, where they are now,
    // then the new ones.
    QSet<int> handled = watch.moved;
    QList<SeenWindow> todo;
    for (const SeenWindow& w : now) {
        if (!watch.leavingFullScreen.contains(w.number)) continue;
        handled.insert(w.number);
        if (watch.age.elapsed() - watch.leavingFullScreen.value(w.number) >= kLeaveFullScreenMs)
            todo.append(w);
    }
    for (auto it = watch.leavingFullScreen.cbegin(); it != watch.leavingFullScreen.cend(); ++it)
        handled.insert(it.key());
    todo += windowsToMove(watch.before, handled, now, target);
    for (const SeenWindow& w : todo) {
        const bool wasFullScreen = watch.leavingFullScreen.contains(w.number);
        const Step step = stepWindow(owners.value(w.number), w.bounds, target, wasFullScreen);
        if (step == Step::NotYet) continue;
        if (step == Step::LeavingFullScreen) {
            watch.leavingFullScreen.insert(w.number, watch.age.elapsed());
            continue;
        }
        watch.leavingFullScreen.remove(w.number);
        watch.moved.insert(w.number);
        Logger::info(
            QStringLiteral("[HostApp] %1 window %2 of %3 onto the virtual display%4")
                .arg(step == Step::Moved ? QStringLiteral("moved")
                                         : QStringLiteral("could not move"))
                .arg(w.number)
                .arg(watch.bundleId)
                .arg(wasFullScreen ? QStringLiteral(", in full screen again") : QString()));
    }
}

} // namespace

bool openOnVirtualDisplay(const QString& command, QString* error)
{
    const QString bundleId = bundleIdFor(command);
    auto watch = std::make_shared<Watch>();
    if (!bundleId.isEmpty()) {
        watch->bundleId = bundleId;
        for (const SeenWindow& w : windowsOf(processesOf(bundleId), nullptr))
            watch->before.insert(w.number);
    }
    if (!open(command, error)) return false;
    if (bundleId.isEmpty()) return true;
    if (!AXIsProcessTrusted()) {
        Logger::warning(QStringLiteral("[HostApp] no Accessibility grant: %1 stays where it "
                                       "opens, which may not be the virtual display")
                            .arg(bundleId));
        return true;
    }
    watch->age.start();
    auto* timer = new QTimer(QCoreApplication::instance());
    timer->setInterval(kTickMs);
    QObject::connect(timer, &QTimer::timeout, timer, [timer, watch]() {
        // A window still out of full screen when the watch ends stays where
        // it is, windowed: logged, the owner puts it back with one click.
        if (watch->age.elapsed() > kWatchMs) {
            for (auto it = watch->leavingFullScreen.cbegin(); it != watch->leavingFullScreen.cend();
                 ++it)
                Logger::warning(QStringLiteral("[HostApp] window %1 of %2 left full screen but "
                                               "could not be moved")
                                    .arg(it.key())
                                    .arg(watch->bundleId));
            timer->deleteLater();
            return;
        }
        pullOnce(*watch);
    });
    timer->start();
    return true;
}

} // namespace HostAppLauncher
