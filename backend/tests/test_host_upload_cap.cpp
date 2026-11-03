/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * The bench's cap on the host's other uploads (HostUploadCap.h, hostcap=).
 *
 * Nothing here sets a policy: the scripts are only built and read. What
 * matters is that the stream's exemption is set before the cap and removed
 * after it, that the executable's path cannot end the quoted string it sits
 * in, that leftovers of dead workers are swept, and that PowerShell receives
 * exactly the script built.
 */

#include "../src/streaming/HostUploadCap.h"

#include "mw/native/EncoderTuning.h"

#include "test_framework.h"

#include <QByteArray>
#include <QString>

using namespace mw::hostcap;

namespace {

bool has(const std::string& s, const std::string& part)
{
    return s.find(part) != std::string::npos;
}

std::string decoded(const std::string& base64)
{
    const QByteArray raw = QByteArray::fromBase64(QByteArray::fromStdString(base64));
    QString text;
    for (int i = 0; i + 1 < raw.size(); i += 2) {
        const char16_t u = static_cast<char16_t>(static_cast<unsigned char>(raw[i]) |
                                                 (static_cast<unsigned char>(raw[i + 1]) << 8));
        text.append(QChar(u));
    }
    return text.toStdString();
}

} // namespace

void run_host_upload_cap_tests()
{
    SECTION("HostUploadCap — the policies are named after the worker");
    {
        CHECK_EQ(capName(4242), std::string("MoonlightWeb host cap 4242"));
        CHECK_EQ(streamName(4242), std::string("MoonlightWeb stream 4242"));
    }

    SECTION("HostUploadCap — a quote in the path cannot end the literal");
    {
        CHECK_EQ(psQuote("C:\\a b\\x.exe"), std::string("'C:\\a b\\x.exe'"));
        CHECK_EQ(psQuote("C:\\Bob's\\x.exe"), std::string("'C:\\Bob''s\\x.exe'"));
        CHECK_EQ(psQuote(""), std::string("''"));
    }

    SECTION("HostUploadCap — on: sweep, then the stream's exemption, then the cap");
    {
        const std::string s =
            onScript(4242, "C:\\Program Files\\MoonlightWeb\\MoonlightWeb.exe", 20, 34);
        // Leftovers of workers no longer running.
        CHECK(has(s, "'^MoonlightWeb (host cap|stream) (\\d+)$'"));
        CHECK(has(s, "Get-Process -Id ([int]$Matches[2])"));
        // The exemption: this executable, its own DSCP, no cap, and the highest
        // precedence, or the cap wins over it.
        const size_t stream = s.find("New-NetQosPolicy -Name 'MoonlightWeb stream 4242'");
        CHECK(stream != std::string::npos);
        CHECK(has(
            s, "-AppPathNameMatchCondition 'C:\\Program Files\\MoonlightWeb\\MoonlightWeb.exe'"));
        CHECK(has(s, "-DSCPAction 34 "));
        const size_t streamEnd = s.find('\n', stream);
        const std::string streamLine = s.substr(stream, streamEnd - stream);
        CHECK(has(streamLine, " -Precedence 255 "));
        CHECK(!has(streamLine, "-ThrottleRateActionBitsPerSecond"));
        // The cap: everything, 20 Mbit/s in bits per second, ActiveStore only.
        const size_t cap = s.find("New-NetQosPolicy -Name 'MoonlightWeb host cap 4242'");
        CHECK(cap != std::string::npos);
        CHECK(stream < cap);
        CHECK(!has(s.substr(cap, s.find('\n', cap) - cap), "-Precedence"));
        CHECK(has(s, "-ThrottleRateActionBitsPerSecond 20000000 "));
        CHECK(!has(s, "PolicyStore localhost"));
        size_t at = 0;
        int newPolicies = 0;
        while ((at = s.find("New-NetQosPolicy", at)) != std::string::npos) {
            ++newPolicies;
            CHECK(s.compare(s.find("-PolicyStore", at), 25, "-PolicyStore ActiveStore ") == 0);
            at += 16;
        }
        CHECK_EQ(newPolicies, 2);
        // The line the worker reads as success comes last.
        CHECK(s.size() > 6 && s.compare(s.size() - 6, 6, "'set'\n") == 0);
        // 10 Gbit/s, the most the key takes, still fits.
        CHECK(has(onScript(1, "x.exe", kMaxMbps, 0),
                  "-ThrottleRateActionBitsPerSecond 10000000000 "));
    }

    SECTION("HostUploadCap — off: the cap first, twice, 5 s apart");
    {
        const std::string s = offScript(4242);
        CHECK(has(s, "$names = 'MoonlightWeb host cap 4242', 'MoonlightWeb stream 4242'"));
        CHECK(has(s, "foreach ($round in 1, 2)"));
        CHECK(has(s, "Start-Sleep -Seconds 5"));
        CHECK(has(s, "Remove-NetQosPolicy -Name $n -PolicyStore ActiveStore -Confirm:$false"));
        CHECK(!has(s, "New-NetQosPolicy"));
    }

    SECTION("HostUploadCap — PowerShell gets the script back, accents and all");
    {
        const std::string script =
            onScript(7, "D:\\Jeux d'été\\MoonlightWeb.exe", 50, 34) + "# ü €\n";
        CHECK_EQ(decoded(encodedCommand(script)), script);
        // UTF-16LE: 'A' is 41 00.
        CHECK_EQ(encodedCommand("A"), std::string("QQA="));
    }

    SECTION("HostUploadCap — hostcap= is a key of its own in the tuning");
    {
        mw::native::EncoderTuning t;
        CHECK(t.isDefault());
        t.hostCapMbps = 20;
        CHECK(!t.isDefault());
        CHECK(has(t.describe(), "hostcap=20"));
    }

    SECTION("HostUploadCap — start(0) and stop() without a start do nothing");
    {
        Cap c;
        c.start(0, 34);
        c.stop();
        c.stop();
        CHECK(true);
    }
}
