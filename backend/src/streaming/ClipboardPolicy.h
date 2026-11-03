/* MoonlightWeb - clipboard support. GPLv3 - see repository LICENSE. */
#pragma once

#include <vector>
#include <atomic>
#include <QJsonObject>

namespace ClipboardPolicy {
inline bool enabled(bool nativeHost, bool selfAddress, bool unrestricted)
{
    return unrestricted && (nativeHost || selfAddress);
}

struct SessionSettings
{
    std::atomic<bool> send{false};
    std::atomic<bool> receive{false};

    // A new transport must negotiate again, even when the relay is reused.
    void reset()
    {
        send.store(false);
        receive.store(false);
    }

    // Shared by all three transports so configuration and paste gates cannot drift.
    template <typename Subscribe, typename Paste>
    bool handleMessage(const QString& type, const QJsonObject& msg, bool available,
                       Subscribe subscribe, Paste paste)
    {
        if (type == QLatin1String("clipboardconfig")) {
            if (available) {
                configure(msg);
                subscribe(receive.load());
            }
            return true;
        }
        if (type == QLatin1String("clipboardpaste")) {
            if (available && send.load())
                paste(msg["text"].toString(), msg["injectCtrl"].toBool(false));
            return true;
        }
        return false;
    }

    template <typename Forward> void forwardHostText(const QString& text, Forward forward) const
    {
        // Check at delivery time too: a host update can already be queued when disabled.
        if (receive.load()) forward(text);
    }

    void configure(const QJsonObject& msg)
    {
        send.store(msg["send"].toBool(false));
        receive.store(msg["receive"].toBool(false));
    }
};

struct KeyEvent
{
    short key;
    bool down;
    char modifiers;
};

inline std::vector<KeyEvent> pasteKeys(bool macHost, bool wrapControl)
{
    // The modifier belongs to the target OS, not to the browser's platform.
    const short modifier = macHost ? 0x5B : 0x11;
    const char flags = macHost ? 0x08 : 0x02;
    const bool wrap = macHost || wrapControl;
    std::vector<KeyEvent> keys;
    if (wrap) keys.push_back({modifier, true, flags});
    keys.push_back({0x56, true, flags});
    keys.push_back({0x56, false, flags});
    if (wrap) keys.push_back({modifier, false, 0});
    return keys;
}
} // namespace ClipboardPolicy
