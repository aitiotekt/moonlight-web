// `wgc` — Windows.Graphics.Capture in front of the D3D12 chain, two ways,
// against Desktop Duplication (plan « Gels du lien », route B, 21/10/2026).
//
// The traces of 21/10 put the N95's lags in the duplication's own packets: under
// a browser's video and Steam, the D3D11 runtime's calls that submit them
// (Signal + Flush, Wait, ReleaseFrame, AcquireNextFrame) block the capture
// thread 10 to 90 ms at a time, while the D3D12 conversion queue waits 3 ms at
// most. WGC under the same load, through the D3D11 chain, had 15 gaps over
// 50 ms against 94. The D3D12 chain takes a surface it opens by an NT handle,
// ordered by DdaInterop's fences A and B; WGC's pool textures have no handle.
//
// `copy` (B1): the pool on a D3D11 device of the capture's own (the product's
// WgcCapture); each frame copied on that device's context into a texture of
// ours with an NT handle, which the chain opens and reads ordered by fences A
// and B — the duplication's handshake, unchanged, with one copy in front.
// `on12` (B2): the pool on a D3D11On12 device carried by the chain's queue;
// the frame's texture unwrapped to D3D12 (UnwrapUnderlyingResource) for the
// read and returned after it (ReturnUnderlyingResource), no copy, no fence of
// ours. `dda`: the product's duplication and its fences, the control.
//
// Per frame: the wait for it, the copy or unwrap call, the hold (acquire →
// release), the release call, when the D3D12 read was done, and the gaps
// between frames over --gap ms — what the lags are made of. The read against
// the frame delivered: the bands of scripts/bench/content/scroll.html?band=1
// when the display shows them, the raw bytes of the two band areas otherwise.
// --border: while WGC runs, one Desktop Duplication frame of the display, its
// top rows looked at for the yellow capture border Windows 11 draws unless the
// session is let off it.

#include "Wgc.h"

#include "Json.h"
#include "Lab.h"

#include "capture/windows/DxgiDuplication.h"
#include "capture/windows/WgcCapture.h"
#include "mw/native/NativeHost.h"
#include "platform/windows/StreamPriority.h"
#include "platform/windows/d3d12/D3d12Device.h"
#include "platform/windows/d3d12/DdaInterop.h"

#include <d3d11on12.h>
#include <dxgi1_6.h>

#include <algorithm>
#include <cctype>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace lab {
namespace {

using namespace mw::native;

constexpr UINT kBandW = 192;
constexpr UINT kBandH = 16;
constexpr UINT kBandPitch = kBandW * 4;
constexpr UINT64 kBottomOffset = kBandPitch * kBandH;

struct Options
{
    std::string display;
    int seconds = 10;
    int rounds = 2;
    std::vector<std::string> arms = {"dda", "copy", "on12"};
    std::string gpuClass = "auto";
    double gapMs = 50;
    int ring = 2;
    bool border = false;
    std::wstring jsonPath;
    bool json = true;
};

void say(const char* format, ...)
{
    va_list args;
    va_start(args, format);
    std::vprintf(format, args);
    va_end(args);
    std::fflush(stdout);
}

std::vector<std::string> split(const std::string& text)
{
    std::vector<std::string> out;
    size_t start = 0;
    while (start <= text.size()) {
        const size_t comma = text.find(',', start);
        const std::string item =
            text.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
        if (!item.empty()) out.push_back(item);
        if (comma == std::string::npos) break;
        start = comma + 1;
    }
    return out;
}

double ms(int64_t us)
{
    return static_cast<double>(us) / 1000.0;
}

/// As `interop` decodes a band: -1 when half-written or absent.
long long decode(const uint8_t* rows, size_t pitch)
{
    long long value = 0;
    for (int bit = 0; bit < 24; ++bit) {
        const size_t x = static_cast<size_t>(bit * 8 + 4) * 4;
        const int a = rows[4 * pitch + x + 1];
        const int b = rows[12 * pitch + x + 1];
        if (std::abs(a - b) < 100) return -1;
        if (a > b) value |= 1ll << bit;
    }
    return value;
}

struct Stats
{
    double mean = 0, p99 = 0, max = 0;
};

Stats stats(std::vector<double> v)
{
    Stats s;
    if (v.empty()) return s;
    std::sort(v.begin(), v.end());
    double sum = 0;
    for (double x : v)
        sum += x;
    s.mean = sum / v.size();
    s.p99 = v[std::min(v.size() - 1, static_cast<size_t>(v.size() * 0.99))];
    s.max = v.back();
    return s;
}

struct Run
{
    std::string arm;
    int round = 0;
    std::string refused;
    std::string note;
    int frames = 0, timeouts = 0, pointerOnly = 0, lost = 0;
    int gaps = 0;
    double gapMaxMs = 0;
    int noBand = 0, readDiffers = 0, readTorn = 0, rawSame = 0, rawDiffers = 0, readLate = 0;
    std::vector<double> acquireMs, prepMs, holdMs, releaseMs, readDoneMs;
    double seconds = 0;
};

bool parse(int argc, wchar_t** argv, Options& o)
{
    for (int i = 0; i < argc; ++i) {
        const std::wstring arg = argv[i];
        auto next = [&]() -> std::string { return i + 1 < argc ? utf8(argv[++i]) : std::string(); };
        if (arg == L"--display") {
            o.display = next();
        } else if (arg == L"--seconds") {
            o.seconds = std::max(1, std::atoi(next().c_str()));
        } else if (arg == L"--rounds") {
            o.rounds = std::max(1, std::atoi(next().c_str()));
        } else if (arg == L"--arms") {
            o.arms = split(next());
        } else if (arg == L"--class") {
            o.gpuClass = next();
        } else if (arg == L"--gap") {
            o.gapMs = std::max(1.0, std::atof(next().c_str()));
        } else if (arg == L"--ring") {
            o.ring = std::max(1, std::min(8, std::atoi(next().c_str())));
        } else if (arg == L"--border") {
            o.border = true;
        } else if (arg == L"--json") {
            o.jsonPath = i + 1 < argc ? argv[++i] : L"";
        } else if (arg == L"--no-json") {
            o.json = false;
        } else {
            return false;
        }
    }
    return isGpuClassOption(o.gpuClass);
}

/// The two bands of a BGRA surface into @p readback, recorded on @p list.
void recordBands(ID3D12GraphicsCommandList* list, ID3D12Resource* surface, ID3D12Resource* readback,
                 UINT height)
{
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = surface;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COMMON;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
    list->ResourceBarrier(1, &barrier);
    for (int band = 0; band < 2; ++band) {
        D3D12_TEXTURE_COPY_LOCATION to = {}, from = {};
        to.pResource = readback;
        to.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        to.PlacedFootprint.Offset = band ? kBottomOffset : 0;
        to.PlacedFootprint.Footprint = {DXGI_FORMAT_B8G8R8A8_UNORM, kBandW, kBandH, 1, kBandPitch};
        from.pResource = surface;
        from.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        const D3D12_BOX box = {0, band ? height - kBandH : 0, 0, kBandW, band ? height : kBandH, 1};
        list->CopyTextureRegion(&to, 0, 0, 0, &from, &box);
    }
    std::swap(barrier.Transition.StateBefore, barrier.Transition.StateAfter);
    list->ResourceBarrier(1, &barrier);
}

/// The bands read back by D3D12, against the truth copied on the capture
/// context: decoded when the display shows bands, compared byte for byte
/// otherwise.
void compare(Run& run, ID3D12Resource* readback, ID3D11DeviceContext* context,
             ID3D11Texture2D* staging)
{
    std::vector<uint8_t> read(2 * kBottomOffset), truth(2 * kBottomOffset);
    bool haveRead = false, haveTruth = false;
    uint8_t* mapped = nullptr;
    const D3D12_RANGE range = {0, static_cast<SIZE_T>(2 * kBottomOffset)};
    if (SUCCEEDED(readback->Map(0, &range, reinterpret_cast<void**>(&mapped)))) {
        std::memcpy(read.data(), mapped, read.size());
        const D3D12_RANGE none = {0, 0};
        readback->Unmap(0, &none);
        haveRead = true;
    }
    D3D11_MAPPED_SUBRESOURCE m = {};
    if (SUCCEEDED(context->Map(staging, 0, D3D11_MAP_READ, 0, &m))) {
        const auto* rows = static_cast<const uint8_t*>(m.pData);
        for (UINT y = 0; y < 2 * kBandH; ++y)
            std::memcpy(truth.data() + static_cast<size_t>(y) * kBandPitch,
                        rows + static_cast<size_t>(y) * m.RowPitch, kBandPitch);
        context->Unmap(staging, 0);
        haveTruth = true;
    }
    if (!haveRead || !haveTruth) {
        ++run.noBand;
        return;
    }
    const long long truthTop = decode(truth.data(), kBandPitch);
    const long long truthBottom = decode(truth.data() + kBottomOffset, kBandPitch);
    if (truthTop < 0 || truthBottom < 0) {
        ++run.noBand;
        if (std::memcmp(read.data(), truth.data(), read.size()) == 0)
            ++run.rawSame;
        else
            ++run.rawDiffers;
        return;
    }
    const long long readTop = decode(read.data(), kBandPitch);
    const long long readBottom = decode(read.data() + kBottomOffset, kBandPitch);
    if (readTop < 0 || readBottom < 0 || readTop != readBottom) ++run.readTorn;
    if (readTop != truthTop || readBottom != truthBottom) ++run.readDiffers;
}

/// The DXGI output @p outputIndex of the adapter @p luid.
ComPtr<IDXGIOutput> findOutput(uint64_t luid, unsigned outputIndex, std::string& error)
{
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(::CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
        error = "no DXGI factory";
        return nullptr;
    }
    for (UINT i = 0;; ++i) {
        ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(i, &adapter) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_ADAPTER_DESC1 desc = {};
        adapter->GetDesc1(&desc);
        if (d3d12::luidValue(desc.AdapterLuid) != luid) continue;
        ComPtr<IDXGIOutput> output;
        if (FAILED(adapter->EnumOutputs(outputIndex, &output))) {
            error = "the adapter has no output " + std::to_string(outputIndex);
            return nullptr;
        }
        return output;
    }
    error = "no adapter with that LUID";
    return nullptr;
}

ComPtr<ID3D11Texture2D> stagingFor(ID3D11Device* device)
{
    D3D11_TEXTURE2D_DESC sd = {};
    sd.Width = kBandW;
    sd.Height = 2 * kBandH;
    sd.MipLevels = 1;
    sd.ArraySize = 1;
    sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.Usage = D3D11_USAGE_STAGING;
    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    device->CreateTexture2D(&sd, nullptr, &staging);
    return staging;
}

/// The truth: the two band areas of the frame the capture delivered, copied
/// on the capture's own context.
void copyTruth(ID3D11DeviceContext* context, ID3D11Texture2D* staging, ID3D11Texture2D* from,
               UINT height)
{
    const D3D11_BOX top = {0, 0, 0, kBandW, kBandH, 1};
    const D3D11_BOX bottom = {0, height - kBandH, 0, kBandW, height, 1};
    context->CopySubresourceRegion(staging, 0, 0, 0, 0, from, 0, &top);
    context->CopySubresourceRegion(staging, 0, 0, kBandH, 0, from, 0, &bottom);
}

struct Lists
{
    ComPtr<ID3D12CommandAllocator> allocator;
    ComPtr<ID3D12GraphicsCommandList> list;
    ComPtr<ID3D12Resource> readback;
    d3d12::GpuFence fence;

    bool init(ID3D12Device* device, std::string& error)
    {
        D3D12_HEAP_PROPERTIES heap = {};
        heap.Type = D3D12_HEAP_TYPE_READBACK;
        D3D12_RESOURCE_DESC buffer = {};
        buffer.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
        buffer.Width = 2 * kBottomOffset;
        buffer.Height = 1;
        buffer.DepthOrArraySize = 1;
        buffer.MipLevels = 1;
        buffer.SampleDesc.Count = 1;
        buffer.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
        HRESULT h = device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                                                   IID_PPV_ARGS(&allocator));
        if (SUCCEEDED(h))
            h = device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocator.Get(),
                                          nullptr, IID_PPV_ARGS(&list));
        if (SUCCEEDED(h)) h = list->Close();
        if (SUCCEEDED(h))
            h = device->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &buffer,
                                                D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                                IID_PPV_ARGS(&readback));
        if (FAILED(h)) {
            error = "lists " + hr(h);
            return false;
        }
        return fence.create(device, false, error);
    }
};

/// The gaps between frames, the lags' own measure.
struct Timeline
{
    int64_t lastAcquired = 0;
    void frame(Run& run, const Options& o, int64_t acquired)
    {
        if (lastAcquired) {
            const double gap = ms(acquired - lastAcquired);
            if (gap > o.gapMs) {
                ++run.gaps;
                run.gapMaxMs = std::max(run.gapMaxMs, gap);
            }
        }
        lastAcquired = acquired;
    }
};

/// One Desktop Duplication frame of the display while WGC runs, its top rows
/// counted for the yellow border (R and G high, B low) — DWM composes the
/// border into the desktop, and the duplication sees the desktop.
std::string lookForBorder(const GpuInfo& gpu, unsigned outputIndex)
{
    std::string error;
    ComPtr<IDXGIOutput> output = findOutput(gpu.nativeHandle, outputIndex, error);
    if (!output) return "border check: " + error;
    ComPtr<IDXGIOutput5> output5;
    if (FAILED(output.As(&output5))) return "border check: no IDXGIOutput5";
    ComPtr<IDXGIAdapter> adapter;
    output->GetParent(IID_PPV_ARGS(&adapter));
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_0};
    HRESULT h = ::D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                    D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 1, D3D11_SDK_VERSION,
                                    &device, nullptr, &context);
    if (FAILED(h)) return "border check: no D3D11 device " + hr(h);
    const DXGI_FORMAT formats[] = {DXGI_FORMAT_B8G8R8A8_UNORM};
    ComPtr<IDXGIOutputDuplication> duplication;
    h = output5->DuplicateOutput1(device.Get(), 0, 1, formats, &duplication);
    if (FAILED(h)) return "border check: DuplicateOutput1 " + hr(h);
    DXGI_OUTDUPL_DESC dd = {};
    duplication->GetDesc(&dd);
    if (dd.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) return "border check: display not BGRA8";
    const UINT width = dd.ModeDesc.Width, rows = 6;
    D3D11_TEXTURE2D_DESC sd = {};
    sd.Width = width;
    sd.Height = rows;
    sd.MipLevels = 1;
    sd.ArraySize = 1;
    sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.Usage = D3D11_USAGE_STAGING;
    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    if (FAILED(device->CreateTexture2D(&sd, nullptr, &staging))) return "border check: no staging";
    // The first acquire hands the desktop as it is; a frame without a present
    // time is still a picture.
    std::string result = "border check: no frame";
    for (int tries = 0; tries < 20; ++tries) {
        DXGI_OUTDUPL_FRAME_INFO info = {};
        ComPtr<IDXGIResource> resource;
        h = duplication->AcquireNextFrame(250, &info, &resource);
        if (h == DXGI_ERROR_WAIT_TIMEOUT) continue;
        if (FAILED(h)) {
            result = "border check: AcquireNextFrame " + hr(h);
            break;
        }
        ComPtr<ID3D11Texture2D> texture;
        resource.As(&texture);
        const D3D11_BOX top = {0, 0, 0, width, rows, 1};
        context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, texture.Get(), 0, &top);
        D3D11_MAPPED_SUBRESOURCE m = {};
        if (SUCCEEDED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &m))) {
            size_t yellow = 0, total = 0;
            for (UINT y = 0; y < rows; ++y) {
                const auto* row = static_cast<const uint8_t*>(m.pData) + y * m.RowPitch;
                for (UINT x = 0; x < width; ++x) {
                    const uint8_t b = row[x * 4], g = row[x * 4 + 1], r = row[x * 4 + 2];
                    if (r > 180 && g > 140 && b < 110) ++yellow;
                    ++total;
                }
            }
            context->Unmap(staging.Get(), 0);
            const int percent = total ? static_cast<int>(100 * yellow / total) : 0;
            result = "border check: " + std::to_string(percent) +
                     " % of the top 6 rows are yellow — " +
                     (percent > 50 ? "the border shows" : "no border seen");
        }
        duplication->ReleaseFrame();
        break;
    }
    return result;
}

/// The product's arm: DxgiDuplication on a device of its own, DdaInterop's
/// fences on the GPU, the read on the chain's queue.
void runDda(Run& run, const Options& o, const GpuInfo& gpu, unsigned outputIndex,
            const std::shared_ptr<d3d12::D3d12Device>& device, d3d12::Queue& queue, Lists& lists)
{
    std::string error;
    capture::DxgiDuplication duplication(gpu.nativeHandle, outputIndex);
    if (!duplication.start(error)) {
        run.refused = "duplication: " + error;
        return;
    }
    StreamPriority::raiseDevice(duplication.device(), "capture");
    if (duplication.format() != DXGI_FORMAT_B8G8R8A8_UNORM) {
        run.refused = "the display is not SDR 8-bit";
        return;
    }
    d3d12::DdaInterop interop;
    if (!interop.bind(duplication.device(), device, error)) {
        run.refused = error;
        return;
    }
    ComPtr<ID3D11Texture2D> staging = stagingFor(duplication.device());
    const UINT height = static_cast<UINT>(duplication.height());
    Timeline timeline;
    const int64_t started = nowUs();
    while (nowUs() - started < static_cast<int64_t>(o.seconds) * 1000000) {
        capture::CapturedFrame frame;
        const int64_t asked = nowUs();
        const capture::AcquireStatus status = duplication.acquire(100, frame);
        if (status == capture::AcquireStatus::PointerOnly) {
            ++run.pointerOnly;
            continue;
        }
        if (status == capture::AcquireStatus::Timeout) {
            ++run.timeouts;
            continue;
        }
        if (status != capture::AcquireStatus::Ok) {
            ++run.lost;
            if (!duplication.start(error)) {
                run.refused = "duplication lost and not back: " + error;
                break;
            }
            if (!interop.bind(duplication.device(), device, error)) {
                run.refused = error;
                break;
            }
            staging = stagingFor(duplication.device());
            continue;
        }
        const int64_t acquired = nowUs();
        ++run.frames;
        run.acquireMs.push_back(ms(acquired - asked));
        timeline.frame(run, o, acquired);
        ID3D11DeviceContext* context = duplication.context();
        copyTruth(context, staging.Get(), frame.texture, height);
        const int64_t preparing = nowUs();
        ID3D12Resource* surface = interop.open(frame.texture, error);
        const uint64_t a = interop.signalAcquired(context, d3d12::DdaSync::Gpu, error);
        run.prepMs.push_back(ms(nowUs() - preparing));
        lists.allocator->Reset();
        lists.list->Reset(lists.allocator.Get(), nullptr);
        if (surface) recordBands(lists.list.Get(), surface, lists.readback.Get(), height);
        lists.list->Close();
        interop.conversionWaits(queue.queue.Get(), a, error);
        ID3D12CommandList* submit[] = {lists.list.Get()};
        queue.queue->ExecuteCommandLists(1, submit);
        const uint64_t b = interop.conversionSignals(queue.queue.Get(), error);
        const int64_t releasing = nowUs();
        interop.beforeRelease(context, b, d3d12::DdaSync::Gpu, 1000, error);
        duplication.release();
        const int64_t released = nowUs();
        run.holdMs.push_back(ms(released - acquired));
        run.releaseMs.push_back(ms(released - releasing));
        if (interop.converted().wait(b, 10000, error) != d3d12::GpuFence::Wait::Done) {
            ++run.readLate;
            break;
        }
        run.readDoneMs.push_back(ms(nowUs() - acquired));
        if (surface) compare(run, lists.readback.Get(), context, staging.Get());
    }
    run.seconds = ms(nowUs() - started) / 1000.0;
    interop.unbind();
    duplication.stop();
}

/// B1: the product's WgcCapture on its own D3D11 device, each frame copied on
/// that device's context into a shareable texture of ours, opened and read by
/// D3D12 behind DdaInterop's fences, exactly as the duplication's surface.
void runCopy(Run& run, const Options& o, const GpuInfo& gpu, unsigned outputIndex,
             const std::shared_ptr<d3d12::D3d12Device>& device, d3d12::Queue& queue, Lists& lists)
{
    std::string error;
    capture::WgcCapture wgc(gpu.nativeHandle, outputIndex);
    if (!wgc.start(error)) {
        run.refused = "WGC: " + error;
        return;
    }
    run.note = std::string("border ") + (wgc.borderOff() ? "off" : "required");
    if (o.border) run.note += "; " + lookForBorder(gpu, outputIndex);
    StreamPriority::raiseDevice(wgc.device(), "capture (WGC)");
    if (wgc.format() != DXGI_FORMAT_B8G8R8A8_UNORM) {
        run.refused = "WGC hands something other than BGRA8";
        return;
    }
    d3d12::DdaInterop interop;
    if (!interop.bind(wgc.device(), device, error)) {
        run.refused = error;
        return;
    }
    const UINT width = static_cast<UINT>(wgc.width()), height = static_cast<UINT>(wgc.height());
    std::vector<ComPtr<ID3D11Texture2D>> ring(static_cast<size_t>(o.ring));
    for (ComPtr<ID3D11Texture2D>& texture : ring) {
        D3D11_TEXTURE2D_DESC td = {};
        td.Width = width;
        td.Height = height;
        td.MipLevels = 1;
        td.ArraySize = 1;
        td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        td.SampleDesc.Count = 1;
        td.Usage = D3D11_USAGE_DEFAULT;
        td.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
        td.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
        const HRESULT h = wgc.device()->CreateTexture2D(&td, nullptr, &texture);
        if (FAILED(h)) {
            run.refused = "the shareable texture could not be made " + hr(h);
            return;
        }
    }
    ComPtr<ID3D11Texture2D> staging = stagingFor(wgc.device());
    Timeline timeline;
    size_t slot = 0;
    const int64_t started = nowUs();
    while (nowUs() - started < static_cast<int64_t>(o.seconds) * 1000000) {
        capture::CapturedFrame frame;
        const int64_t asked = nowUs();
        const capture::AcquireStatus status = wgc.acquire(100, frame);
        if (status == capture::AcquireStatus::PointerOnly) {
            ++run.pointerOnly;
            continue;
        }
        if (status == capture::AcquireStatus::Timeout) {
            ++run.timeouts;
            continue;
        }
        if (status != capture::AcquireStatus::Ok) {
            ++run.lost;
            run.refused = "WGC lost the display";
            break;
        }
        const int64_t acquired = nowUs();
        ++run.frames;
        run.acquireMs.push_back(ms(acquired - asked));
        timeline.frame(run, o, acquired);
        ID3D11DeviceContext* context = wgc.context();
        copyTruth(context, staging.Get(), frame.texture, height);
        ID3D11Texture2D* shared = ring[slot].Get();
        slot = (slot + 1) % ring.size();
        const int64_t preparing = nowUs();
        // The copy, then the signal: on one context, the GPU does them in that
        // order, and the pool's buffer is free as soon as the copy is queued.
        context->CopyResource(shared, frame.texture);
        ID3D12Resource* surface = interop.open(shared, error);
        const uint64_t a = interop.signalAcquired(context, d3d12::DdaSync::Gpu, error);
        run.prepMs.push_back(ms(nowUs() - preparing));
        lists.allocator->Reset();
        lists.list->Reset(lists.allocator.Get(), nullptr);
        if (surface) recordBands(lists.list.Get(), surface, lists.readback.Get(), height);
        lists.list->Close();
        interop.conversionWaits(queue.queue.Get(), a, error);
        ID3D12CommandList* submit[] = {lists.list.Get()};
        queue.queue->ExecuteCommandLists(1, submit);
        const uint64_t b = interop.conversionSignals(queue.queue.Get(), error);
        const int64_t releasing = nowUs();
        // The next copy into this slot lands behind this wait on the context.
        interop.beforeRelease(context, b, d3d12::DdaSync::Gpu, 1000, error);
        wgc.release();
        const int64_t released = nowUs();
        run.holdMs.push_back(ms(released - acquired));
        run.releaseMs.push_back(ms(released - releasing));
        if (interop.converted().wait(b, 10000, error) != d3d12::GpuFence::Wait::Done) {
            ++run.readLate;
            break;
        }
        run.readDoneMs.push_back(ms(nowUs() - acquired));
        if (surface) compare(run, lists.readback.Get(), context, staging.Get());
    }
    run.seconds = ms(nowUs() - started) / 1000.0;
    interop.unbind();
    wgc.stop();
}

/// B2: WgcCapture on a D3D11On12 device carried by the chain's queue, the
/// frame's texture unwrapped to D3D12 for the read and returned after it.
void runOn12(Run& run, const Options& o, const GpuInfo& gpu, unsigned outputIndex,
             const std::shared_ptr<d3d12::D3d12Device>& device, d3d12::Queue& queue, Lists& lists)
{
    std::string error;
    ComPtr<ID3D11Device> device11;
    ComPtr<ID3D11DeviceContext> context;
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_0};
    IUnknown* queues[] = {queue.queue.Get()};
    HRESULT h = ::D3D11On12CreateDevice(device->device(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels,
                                        1, queues, 1, 0, &device11, &context, nullptr);
    if (FAILED(h)) {
        run.refused = "D3D11On12CreateDevice " + hr(h);
        return;
    }
    ComPtr<ID3D11On12Device2> on12;
    if (FAILED(device11.As(&on12))) {
        run.refused = "no ID3D11On12Device2 (Windows 10 20H1)";
        return;
    }
    capture::WgcCapture wgc(gpu.nativeHandle, outputIndex);
    wgc.useDevice(device11.Get());
    if (!wgc.start(error)) {
        run.refused = "WGC on the 11on12 device: " + error;
        return;
    }
    run.note = std::string("border ") + (wgc.borderOff() ? "off" : "required");
    if (o.border) run.note += "; " + lookForBorder(gpu, outputIndex);
    StreamPriority::raiseDevice(device11.Get(), "capture (WGC on 11on12)");
    if (wgc.format() != DXGI_FORMAT_B8G8R8A8_UNORM) {
        run.refused = "WGC hands something other than BGRA8";
        return;
    }
    const UINT height = static_cast<UINT>(wgc.height());
    ComPtr<ID3D11Texture2D> staging = stagingFor(device11.Get());
    if (!staging) {
        run.refused = "no staging texture on the 11on12 device";
        return;
    }
    Timeline timeline;
    bool saidUnwrap = false;
    const int64_t started = nowUs();
    while (nowUs() - started < static_cast<int64_t>(o.seconds) * 1000000) {
        capture::CapturedFrame frame;
        const int64_t asked = nowUs();
        const capture::AcquireStatus status = wgc.acquire(100, frame);
        if (status == capture::AcquireStatus::PointerOnly) {
            ++run.pointerOnly;
            continue;
        }
        if (status == capture::AcquireStatus::Timeout) {
            ++run.timeouts;
            continue;
        }
        if (status != capture::AcquireStatus::Ok) {
            ++run.lost;
            run.refused = "WGC lost the display";
            break;
        }
        const int64_t acquired = nowUs();
        ++run.frames;
        run.acquireMs.push_back(ms(acquired - asked));
        timeline.frame(run, o, acquired);
        copyTruth(context.Get(), staging.Get(), frame.texture, height);
        // The texture to D3D12, ordered after the compositor's copy into it
        // and the truth copy above: the 11on12 runtime queues what it must.
        const int64_t preparing = nowUs();
        ComPtr<ID3D12Resource> surface;
        h = on12->UnwrapUnderlyingResource(frame.texture, queue.queue.Get(),
                                           IID_PPV_ARGS(&surface));
        run.prepMs.push_back(ms(nowUs() - preparing));
        if (FAILED(h)) {
            if (!saidUnwrap) say("    UnwrapUnderlyingResource refused: %s\n", hr(h).c_str());
            saidUnwrap = true;
            surface.Reset();
        }
        lists.allocator->Reset();
        lists.list->Reset(lists.allocator.Get(), nullptr);
        if (surface) recordBands(lists.list.Get(), surface.Get(), lists.readback.Get(), height);
        lists.list->Close();
        ID3D12CommandList* submit[] = {lists.list.Get()};
        queue.queue->ExecuteCommandLists(1, submit);
        const uint64_t value = lists.fence.signal(queue.queue.Get(), error);
        const int64_t releasing = nowUs();
        if (surface) {
            // Back to D3D11, which lets the pool reuse the buffer only once
            // our read on the queue is done.
            ID3D12Fence* fences[] = {lists.fence.fence()};
            UINT64 values[] = {value};
            h = on12->ReturnUnderlyingResource(frame.texture, 1, values, fences);
            if (FAILED(h) && run.readLate == 0)
                say("    ReturnUnderlyingResource refused: %s\n", hr(h).c_str());
        }
        wgc.release();
        const int64_t released = nowUs();
        run.holdMs.push_back(ms(released - acquired));
        run.releaseMs.push_back(ms(released - releasing));
        if (lists.fence.wait(value, 10000, error) != d3d12::GpuFence::Wait::Done) {
            ++run.readLate;
            break;
        }
        run.readDoneMs.push_back(ms(nowUs() - acquired));
        if (surface) compare(run, lists.readback.Get(), context.Get(), staging.Get());
    }
    run.seconds = ms(nowUs() - started) / 1000.0;
    wgc.stop();
}

} // namespace

void wgcUsage()
{
    std::puts(
        "mw-d3d12-lab wgc [options]\n"
        "  Windows.Graphics.Capture in front of the D3D12 chain, two ways, against Desktop\n"
        "  Duplication: `copy` (the pool on its own D3D11 device, each frame copied into a\n"
        "  shareable texture read behind the duplication's fences), `on12` (the pool on a\n"
        "  D3D11On12 device on the chain's queue, the texture unwrapped for the read), `dda`\n"
        "  (the product's duplication and fences). Per frame: the wait, the copy or unwrap,\n"
        "  the hold, the release, the read done, and the gaps between frames.\n"
        "  --display <which>     'Display 2', a monitor name, or a piece of the GPU's name\n"
        "  --seconds <s>         per run (default 10)\n"
        "  --rounds <n>          rounds of the arms (default 2)\n"
        "  --arms dda,copy,on12  which arms (default all three)\n"
        "  --gap <ms>            a gap between frames counts from here (default 50)\n"
        "  --ring <n>            shareable textures of the copy arm (default 2)\n"
        "  --border              one duplication frame while WGC runs, its top rows looked\n"
        "                        at for the yellow capture border\n"
        "  --class auto|high|normal  the process's GPU scheduling class (auto = REALTIME\n"
        "                        where the token allows it); the queue follows it\n"
        "  --json <file> | --no-json");
}

int runWgc(int argc, wchar_t** argv)
{
    Options o;
    if (!parse(argc, argv, o)) {
        wgcUsage();
        return 2;
    }
    NativeHost::setLogSink([](int level, const std::string& message) {
        if (level >= 2) std::printf("    %s\n", message.c_str());
    });
    StreamPriority priority;
    const GpuScheduling scheduling = takeGpuClass(priority, o.gpuClass);

    const Capabilities caps = NativeHost::probe();
    if (caps.displays.empty()) {
        say("no display\n");
        return 2;
    }
    const DisplayInfo* target = nullptr;
    std::string wanted = o.display;
    for (char& ch : wanted)
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    for (const DisplayInfo& d : caps.displays) {
        if (target) break;
        const GpuInfo* g = caps.gpuFor(d);
        std::string gpuName = g ? g->name : std::string();
        for (char& ch : gpuName)
            ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
        if (o.display.empty() ? d.primary
                              : (d.label.find(o.display) != std::string::npos ||
                                 d.detail.find(o.display) != std::string::npos ||
                                 gpuName.find(wanted) != std::string::npos))
            target = &d;
    }
    if (!target) target = &caps.displays.front();
    const GpuInfo* gpu = caps.gpuFor(*target);
    if (!gpu) {
        say("display %s names no GPU\n", target->label.c_str());
        return 2;
    }
    unsigned outputIndex = 0;
    for (const DisplayInfo& d : caps.displays) {
        if (d.id == target->id) break;
        if (d.gpuId == target->gpuId) ++outputIndex;
    }

    say("mw-d3d12-lab wgc - %s on %s\n", nowText().c_str(), computerName().c_str());
    say("%s on %s, %d s per run, %d round(s), gaps from %.0f ms\n", target->label.c_str(),
        gpu->name.c_str(), o.seconds, o.rounds, o.gapMs);
    say("token %s, GPU class %s\n", scheduling.token.c_str(), scheduling.gpuClass.c_str());
    std::string why;
    const bool wgcAvailable = capture::WgcCapture::available(&why);
    say("Windows.Graphics.Capture: %s%s\n", wgcAvailable ? "available" : "unavailable — ",
        wgcAvailable ? "" : why.c_str());

    std::string error;
    std::shared_ptr<d3d12::D3d12Device> device =
        d3d12::D3d12Device::forAdapter(gpu->nativeHandle, error);
    if (!device) {
        say("no D3D12: %s\n", error.c_str());
        return 1;
    }
    d3d12::Queue queue;
    d3d12::QueueRequest request;
    request.priority = d3d12::QueuePriority::Auto;
    request.name = L"lab wgc";
    if (!device->createQueue(request, queue, error)) {
        say("%s\n", error.c_str());
        return 1;
    }
    say("queue: %s\n\n", queue.description.c_str());
    Lists lists;
    if (!lists.init(device->device(), error)) {
        say("%s\n", error.c_str());
        return 1;
    }

    std::vector<Run> runs;
    for (int round = 1; round <= o.rounds; ++round) {
        for (const std::string& arm : o.arms) {
            Run run;
            run.arm = arm;
            run.round = round;
            say("  %s, round %d...\n", arm.c_str(), round);
            if (arm == "dda")
                runDda(run, o, *gpu, outputIndex, device, queue, lists);
            else if (arm == "copy")
                runCopy(run, o, *gpu, outputIndex, device, queue, lists);
            else if (arm == "on12")
                runOn12(run, o, *gpu, outputIndex, device, queue, lists);
            else
                run.refused = "unknown arm";
            if (!run.note.empty()) say("    %s\n", run.note.c_str());
            if (!run.refused.empty()) say("    refused: %s\n", run.refused.c_str());
            runs.push_back(run);
        }
    }

    say("\n%-5s %2s %6s %4s %4s | %-15s | %-18s | %-18s | %-18s | %-18s | %-18s | %s\n", "arm",
        "rd", "frames", "tmo", "ptr", "gaps n / max ms", "wait mean/p99/max", "prep mean/p99/max",
        "hold mean/p99/max", "release mean/p99/max", "read done mean/p99/max",
        "noband(same/diff) / differs / torn / late");
    for (const Run& r : runs) {
        if (!r.refused.empty()) {
            say("%-5s %2d refused: %s\n", r.arm.c_str(), r.round, r.refused.c_str());
            continue;
        }
        const Stats acq = stats(r.acquireMs), prep = stats(r.prepMs), hold = stats(r.holdMs),
                    rel = stats(r.releaseMs), done = stats(r.readDoneMs);
        say("%-5s %2d %6d %4d %4d | %4d / %8.1f | %5.2f %5.2f %6.1f | %5.2f %5.2f %6.1f | %5.2f "
            "%5.2f %6.1f | %5.2f %5.2f %6.1f | %5.2f %5.2f %6.1f | %d(%d/%d) / %d / %d / %d\n",
            r.arm.c_str(), r.round, r.frames, r.timeouts, r.pointerOnly, r.gaps, r.gapMaxMs,
            acq.mean, acq.p99, acq.max, prep.mean, prep.p99, prep.max, hold.mean, hold.p99,
            hold.max, rel.mean, rel.p99, rel.max, done.mean, done.p99, done.max, r.noBand,
            r.rawSame, r.rawDiffers, r.readDiffers, r.readTorn, r.readLate);
    }

    if (o.json) {
        Json j;
        j.beginObject();
        j.field("tool", "mw-d3d12-lab").field("command", "wgc").field("schema", 1);
        j.field("date", nowText()).field("computer", computerName()).field("os", osBuild());
        j.field("display", target->label).field("gpu", gpu->name);
        j.field("token", scheduling.token).field("gpuClass", scheduling.gpuClass);
        j.field("queue", queue.description).field("gapMs", o.gapMs).field("ring", o.ring);
        j.field("wgcAvailable", wgcAvailable).field("wgcUnavailableWhy", why);
        j.key("runs").beginArray();
        for (const Run& r : runs) {
            j.beginObject();
            j.field("arm", r.arm).field("round", r.round).field("note", r.note);
            if (!r.refused.empty()) {
                j.field("refused", r.refused);
            } else {
                const Stats acq = stats(r.acquireMs), prep = stats(r.prepMs),
                            hold = stats(r.holdMs), rel = stats(r.releaseMs),
                            done = stats(r.readDoneMs);
                j.field("frames", r.frames)
                    .field("timeouts", r.timeouts)
                    .field("pointerOnly", r.pointerOnly)
                    .field("lost", r.lost)
                    .field("seconds", r.seconds);
                j.field("gaps", r.gaps).field("gapMaxMs", r.gapMaxMs);
                j.field("waitMeanMs", acq.mean)
                    .field("waitP99Ms", acq.p99)
                    .field("waitMaxMs", acq.max);
                j.field("prepMeanMs", prep.mean)
                    .field("prepP99Ms", prep.p99)
                    .field("prepMaxMs", prep.max);
                j.field("holdMeanMs", hold.mean)
                    .field("holdP99Ms", hold.p99)
                    .field("holdMaxMs", hold.max);
                j.field("releaseMeanMs", rel.mean)
                    .field("releaseP99Ms", rel.p99)
                    .field("releaseMaxMs", rel.max);
                j.field("readDoneMeanMs", done.mean)
                    .field("readDoneP99Ms", done.p99)
                    .field("readDoneMaxMs", done.max);
                j.field("noBand", r.noBand)
                    .field("rawSame", r.rawSame)
                    .field("rawDiffers", r.rawDiffers)
                    .field("readDiffers", r.readDiffers)
                    .field("readTorn", r.readTorn)
                    .field("readLate", r.readLate);
            }
            j.endObject();
        }
        j.endArray();
        j.endObject();
        std::wstring path = o.jsonPath;
        if (path.empty()) path = wide("wgc-" + computerName() + "-" + nowStamp() + ".json");
        std::ofstream file(path, std::ios::binary);
        file << j.str() << '\n';
        say("JSON: %s\n", utf8(path.c_str()).c_str());
    }
    return 0;
}

} // namespace lab
