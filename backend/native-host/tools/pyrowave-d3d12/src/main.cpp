/*
 * MoonlightWeb — POC Ultra: mw-pyrowave-d3d12, the HLSL PyroWave encoder on a clip.
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

// mw-pyrowave-d3d12 encode <in.y4m> <out.pwv> [--mbps 170] [--packet 1100]
//                          [--vendor 0x10de] [--repeat N] [--debug]
// Without --vendor it runs on WARP (software): see encode(). --dump-coef <file>
// writes the first frame's wavelet bands (raw f32) for a check on the CPU.
//
// Encodes an 8-bit 4:2:0 Y4M clip with PyroWaveEncoder12 on a D3D12 compute
// queue and writes the stream as mw-pyrowave-ref does (.pwv), so the
// reference decoder checks it. --repeat encodes each frame N times more and
// times those (the first pass of a frame pays for the upload and warm-up).
// Every line of output is a JSON object.

#include "PyroWaveEncoder12.h"

#include <d3d12.h>
#include <dxgi1_6.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

struct Y4m
{
    FILE* f = nullptr;
    int width = 0, height = 0, fpsNum = 60, fpsDen = 1;
};

bool openY4m(Y4m& y, const char* path)
{
    y.f = std::fopen(path, "rb");
    if (!y.f) return false;
    char line[512];
    if (!std::fgets(line, sizeof line, y.f) || std::strncmp(line, "YUV4MPEG2", 9) != 0)
        return false;
    for (char* tok = std::strtok(line + 9, " \n"); tok; tok = std::strtok(nullptr, " \n")) {
        if (tok[0] == 'W')
            y.width = std::atoi(tok + 1);
        else if (tok[0] == 'H')
            y.height = std::atoi(tok + 1);
        else if (tok[0] == 'F')
            std::sscanf(tok + 1, "%d:%d", &y.fpsNum, &y.fpsDen);
        else if (tok[0] == 'C' && std::strncmp(tok + 1, "420", 3) != 0)
            return false;
    }
    return y.width > 0 && y.height > 0;
}

bool readFrame(Y4m& y, std::vector<uint8_t>& buf)
{
    char line[128];
    if (!std::fgets(line, sizeof line, y.f) || std::strncmp(line, "FRAME", 5) != 0) return false;
    buf.resize(size_t(y.width) * y.height * 3 / 2);
    return std::fread(buf.data(), 1, buf.size(), y.f) == buf.size();
}

void put32(FILE* f, uint32_t v)
{
    std::fwrite(&v, 4, 1, f);
}

std::string narrow(const wchar_t* w)
{
    char out[256];
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out, sizeof out, nullptr, nullptr);
    return out;
}

D3D12_RESOURCE_BARRIER transition(ID3D12Resource* r, D3D12_RESOURCE_STATES a,
                                  D3D12_RESOURCE_STATES b)
{
    D3D12_RESOURCE_BARRIER t = {};
    t.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    t.Transition.pResource = r;
    t.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    t.Transition.StateBefore = a;
    t.Transition.StateAfter = b;
    return t;
}

ComPtr<ID3D12Resource> makeBuffer(ID3D12Device* d, uint64_t size, D3D12_HEAP_TYPE heap,
                                  D3D12_RESOURCE_STATES state)
{
    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = heap;
    D3D12_RESOURCE_DESC desc = {};
    desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    desc.Width = size;
    desc.Height = 1;
    desc.DepthOrArraySize = 1;
    desc.MipLevels = 1;
    desc.SampleDesc.Count = 1;
    desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    ComPtr<ID3D12Resource> r;
    d->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &desc, state, nullptr, IID_PPV_ARGS(&r));
    return r;
}

// The debug layer's stored messages, to stderr.
void dumpMessages(ID3D12Device* device)
{
    ComPtr<ID3D12InfoQueue> q;
    if (FAILED(device->QueryInterface(IID_PPV_ARGS(&q)))) return;
    for (UINT64 i = 0, n = q->GetNumStoredMessages(); i < n; i++) {
        SIZE_T size = 0;
        q->GetMessage(i, nullptr, &size);
        std::vector<uint8_t> buf(size);
        auto* m = reinterpret_cast<D3D12_MESSAGE*>(buf.data());
        if (SUCCEEDED(q->GetMessage(i, m, &size)))
            std::fprintf(stderr, "d3d12: %s\n", m->pDescription);
    }
    q->ClearStoredMessages();
}

int encode(const char* in, const char* out, double mbps, size_t packet, uint32_t vendor, int repeat,
           bool debug, const char* dumpCoef, bool selfTest, bool nv12)
{
    // --debug: the debug layer with GPU-based validation; its messages are
    // printed when a frame fails and at the end.
    if (debug) {
        ComPtr<ID3D12Debug1> layer;
        if (SUCCEEDED(D3D12GetDebugInterface(IID_PPV_ARGS(&layer)))) {
            layer->EnableDebugLayer();
            layer->SetEnableGPUBasedValidation(TRUE);
        } else {
            std::fprintf(stderr, "no D3D12 debug layer on this machine\n");
        }
    }
    Y4m y;
    if (!openY4m(y, in)) return std::fprintf(stderr, "cannot read %s (8-bit 4:2:0 Y4M)\n", in), 2;

    ComPtr<IDXGIFactory6> factory;
    if (FAILED(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory))))
        return std::fprintf(stderr, "no DXGI\n"), 3;
    ComPtr<IDXGIAdapter1> adapter;
    DXGI_ADAPTER_DESC1 ad = {};
    // No vendor asked for: WARP, the software rasterizer. A new or changed
    // shader runs there first: on a real GPU a hang resets its driver, and
    // every GPU of the bench host drives a screen (05/10/2026: the RTX).
    if (vendor == 0 && SUCCEEDED(factory->EnumWarpAdapter(IID_PPV_ARGS(&adapter))))
        adapter->GetDesc1(&ad);
    for (UINT i = 0; !adapter; i++) {
        ComPtr<IDXGIAdapter1> a;
        if (factory->EnumAdapterByGpuPreference(i, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                                                IID_PPV_ARGS(&a)) == DXGI_ERROR_NOT_FOUND)
            break;
        DXGI_ADAPTER_DESC1 d;
        a->GetDesc1(&d);
        if (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
        if (vendor == 0 || d.VendorId == vendor) {
            adapter = a;
            ad = d;
            break;
        }
    }
    if (!adapter) return std::fprintf(stderr, "no adapter for vendor 0x%04x\n", vendor), 3;
    ComPtr<ID3D12Device> device;
    if (FAILED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device))))
        return std::fprintf(stderr, "D3D12CreateDevice failed\n"), 3;
    std::printf("{\"gpu_name\":\"%s\",\"vendor\":\"0x%04x\"}\n", narrow(ad.Description).c_str(),
                ad.VendorId);

    D3D12_COMMAND_QUEUE_DESC qd = {};
    qd.Type = D3D12_COMMAND_LIST_TYPE_COMPUTE;
    ComPtr<ID3D12CommandQueue> queue;
    ComPtr<ID3D12CommandAllocator> alloc;
    ComPtr<ID3D12GraphicsCommandList> cmd;
    ComPtr<ID3D12Fence> fence;
    device->CreateCommandQueue(&qd, IID_PPV_ARGS(&queue));
    device->CreateCommandAllocator(qd.Type, IID_PPV_ARGS(&alloc));
    device->CreateCommandList(0, qd.Type, alloc.Get(), nullptr, IID_PPV_ARGS(&cmd));
    cmd->Close();
    device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence));
    HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    uint64_t fenceValue = 0;
    uint64_t frequency = 0;
    queue->GetTimestampFrequency(&frequency);

    mw::native::encode::PyroWaveEncoder12 enc;
    std::string error;
    if (!enc.init(device.Get(), y.width, y.height, &error))
        return std::fprintf(stderr, "init: %s\n", error.c_str()), 4;

    if (selfTest) {
        alloc->Reset();
        cmd->Reset(alloc.Get(), nullptr);
        enc.recordSelfTest(cmd.Get());
        cmd->Close();
        ID3D12CommandList* lists[] = {cmd.Get()};
        queue->ExecuteCommandLists(1, lists);
        queue->Signal(fence.Get(), ++fenceValue);
        fence->SetEventOnCompletion(fenceValue, done);
        WaitForSingleObject(done, INFINITE);
        std::string hex;
        bool ok = true;
        auto bytes = enc.selfTestBytes();
        for (size_t i = 0; i < bytes.size(); i++) {
            char t[4];
            std::snprintf(t, sizeof t, "%02x", bytes[i]);
            hex += t;
            uint8_t want = (i & 1) ? uint8_t(0x0f | ((i / 2) << 4)) : uint8_t(0xf0 | (i / 2));
            ok = ok && bytes[i] == want;
        }
        std::printf("{\"selftest\":\"%s\",\"ok\":%s}\n", hex.c_str(), ok ? "true" : "false");
        return ok ? 0 : 6;
    }
    // --nv12: the source laid out as UltraEncoder12 gets it from the engine,
    // an NV12 texture's two planes at their copyable footprints (chroma
    // interleaved), instead of a planar Y4M frame.
    using PW = mw::native::encode::PyroWaveEncoder12;
    PW::SourceLayout layout = PW::planar(y.width, y.height);
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT planes[2] = {};
    if (nv12) {
        D3D12_RESOURCE_DESC td = {};
        td.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
        td.Width = UINT64(y.width);
        td.Height = UINT(y.height);
        td.DepthOrArraySize = 1;
        td.MipLevels = 1;
        td.Format = DXGI_FORMAT_NV12;
        td.SampleDesc.Count = 1;
        UINT64 total = 0;
        device->GetCopyableFootprints(&td, 0, 2, 0, planes, nullptr, nullptr, &total);
        layout.yOffset = uint32_t(planes[0].Offset);
        layout.yPitch = planes[0].Footprint.RowPitch;
        layout.cbOffset = uint32_t(planes[1].Offset);
        layout.crOffset = uint32_t(planes[1].Offset) + 1;
        layout.cPitch = planes[1].Footprint.RowPitch;
        layout.interleaved = true;
        layout.bytes = uint32_t(total);
    }
    const size_t sourceBytes = layout.bytes;
    auto upload = makeBuffer(device.Get(), (sourceBytes + 255) & ~size_t(255),
                             D3D12_HEAP_TYPE_UPLOAD, D3D12_RESOURCE_STATE_GENERIC_READ);
    auto source = makeBuffer(device.Get(), (sourceBytes + 255) & ~size_t(255),
                             D3D12_HEAP_TYPE_DEFAULT, D3D12_RESOURCE_STATE_COPY_DEST);
    D3D12_QUERY_HEAP_DESC qh = {};
    qh.Type = D3D12_QUERY_HEAP_TYPE_TIMESTAMP;
    qh.Count = 6;
    ComPtr<ID3D12QueryHeap> timestamps;
    device->CreateQueryHeap(&qh, IID_PPV_ARGS(&timestamps));
    auto tsReadback =
        makeBuffer(device.Get(), 64, D3D12_HEAP_TYPE_READBACK, D3D12_RESOURCE_STATE_COPY_DEST);
    uint8_t* uploadPtr = nullptr;
    upload->Map(0, nullptr, reinterpret_cast<void**>(&uploadPtr));

    FILE* o = std::fopen(out, "wb");
    if (!o) return std::fprintf(stderr, "cannot write %s\n", out), 2;
    std::fwrite("PWV1", 1, 4, o);
    for (uint32_t v :
         {uint32_t(y.width), uint32_t(y.height), uint32_t(y.fpsNum), uint32_t(y.fpsDen), 0u})
        put32(o, v);

    const double fps = double(y.fpsNum) / y.fpsDen;
    const size_t target = size_t(mbps * 1e6 / 8.0 / fps);
    std::vector<uint8_t> frame;
    std::vector<std::vector<uint8_t>> packets;
    uint32_t frames = 0;
    double bytesTotal = 0;
    std::vector<double> gpu;
    auto submit = [&](bool copy) {
        alloc->Reset();
        cmd->Reset(alloc.Get(), nullptr);
        if (copy) {
            auto toCopy = transition(source.Get(), D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,
                                     D3D12_RESOURCE_STATE_COPY_DEST);
            if (frames > 0) cmd->ResourceBarrier(1, &toCopy);
            cmd->CopyBufferRegion(source.Get(), 0, upload.Get(), 0, sourceBytes);
            auto toRead = transition(source.Get(), D3D12_RESOURCE_STATE_COPY_DEST,
                                     D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
            cmd->ResourceBarrier(1, &toRead);
        }
        enc.record(cmd.Get(), source.Get(), layout, target, timestamps.Get(), 0, tsReadback.Get());
        cmd->Close();
        ID3D12CommandList* lists[] = {cmd.Get()};
        queue->ExecuteCommandLists(1, lists);
        queue->Signal(fence.Get(), ++fenceValue);
        fence->SetEventOnCompletion(fenceValue, done);
        WaitForSingleObject(done, INFINITE);
    };
    while (readFrame(y, frame)) {
        if (nv12) {
            const size_t w = size_t(y.width), h = size_t(y.height);
            const uint8_t* cb = frame.data() + w * h;
            const uint8_t* cr = cb + (w / 2) * (h / 2);
            for (size_t r = 0; r < h; r++)
                std::memcpy(uploadPtr + layout.yOffset + r * layout.yPitch, frame.data() + r * w,
                            w);
            for (size_t r = 0; r < h / 2; r++) {
                uint8_t* row = uploadPtr + layout.cbOffset + r * layout.cPitch;
                for (size_t x = 0; x < w / 2; x++) {
                    row[2 * x] = cb[r * (w / 2) + x];
                    row[2 * x + 1] = cr[r * (w / 2) + x];
                }
            }
        } else {
            std::memcpy(uploadPtr, frame.data(), sourceBytes);
        }
        submit(true);
        if (frames == 0 && dumpCoef) {
            // The first frame's wavelet bands (raw f32) and the 8x8 blocks'
            // code words (<file>.meta, u32), for a check on the CPU.
            auto dump = [&](ID3D12Resource* src, uint64_t size, const std::string& path) {
                auto rb = makeBuffer(device.Get(), size, D3D12_HEAP_TYPE_READBACK,
                                     D3D12_RESOURCE_STATE_COPY_DEST);
                alloc->Reset();
                cmd->Reset(alloc.Get(), nullptr);
                auto toCopy = transition(src, D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
                                         D3D12_RESOURCE_STATE_COPY_SOURCE);
                cmd->ResourceBarrier(1, &toCopy);
                cmd->CopyBufferRegion(rb.Get(), 0, src, 0, size);
                std::swap(toCopy.Transition.StateBefore, toCopy.Transition.StateAfter);
                cmd->ResourceBarrier(1, &toCopy);
                cmd->Close();
                ID3D12CommandList* lists[] = {cmd.Get()};
                queue->ExecuteCommandLists(1, lists);
                queue->Signal(fence.Get(), ++fenceValue);
                fence->SetEventOnCompletion(fenceValue, done);
                WaitForSingleObject(done, INFINITE);
                void* p = nullptr;
                rb->Map(0, nullptr, &p);
                if (FILE* f = std::fopen(path.c_str(), "wb")) {
                    std::fwrite(p, 1, size_t(size), f);
                    std::fclose(f);
                }
                rb->Unmap(0, nullptr);
            };
            dump(enc.coefficients(), uint64_t(enc.coefficientCount()) * 4, dumpCoef);
            dump(enc.blockMeta(), uint64_t(enc.blockCount8x8()) * 4,
                 std::string(dumpCoef) + ".meta");
        }
        for (int r = 0; r < repeat; r++) {
            submit(false);
            gpu.push_back(
                mw::native::encode::PyroWaveEncoder12::stageTimes(tsReadback.Get(), 0, frequency)
                    .total());
        }
        auto t = mw::native::encode::PyroWaveEncoder12::stageTimes(tsReadback.Get(), 0, frequency);
        if (debug) dumpMessages(device.Get());
        if (HRESULT removed = device->GetDeviceRemovedReason(); FAILED(removed))
            return std::fprintf(stderr, "frame %u: device removed (0x%08lx)\n", frames,
                                (unsigned long)removed),
                   5;
        if (!enc.packets(packet, packets, &error))
            return std::fprintf(stderr, "frame %u: %s\n", frames, error.c_str()), 5;
        size_t bytes = 0;
        put32(o, uint32_t(packets.size()));
        for (auto& p : packets) {
            put32(o, uint32_t(p.size()));
            std::fwrite(p.data(), 1, p.size(), o);
            bytes += p.size();
        }
        bytesTotal += double(bytes);
        std::printf(
            "{\"frame\":%u,\"bytes\":%zu,\"packets\":%zu,\"gpu_ms\":{\"dwt\":%.3f,\"quant\":%.3f,"
            "\"analyze\":%.3f,\"resolve\":%.3f,\"pack\":%.3f,\"total\":%.3f}}\n",
            frames, bytes, packets.size(), t.dwt, t.quant, t.analyze, t.resolve, t.pack, t.total());
        frames++;
    }
    std::fseek(o, 4 + 4 * 4, SEEK_SET);
    put32(o, frames);
    std::fclose(o);
    std::sort(gpu.begin(), gpu.end());
    std::printf(
        "{\"done\":\"encode\",\"frames\":%u,\"width\":%d,\"height\":%d,\"target_mbps\":%.1f,"
        "\"mean_mbps\":%.2f,\"gpu_ms_p50\":%.3f,\"gpu_ms_p99\":%.3f}\n",
        frames, y.width, y.height, mbps, frames ? bytesTotal * 8 * fps / frames / 1e6 : 0.0,
        gpu.empty() ? 0.0 : gpu[gpu.size() / 2],
        gpu.empty() ? 0.0 : gpu[std::min(gpu.size() - 1, gpu.size() * 99 / 100)]);
    return 0;
}

} // namespace

int main(int argc, char** argv)
{
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 4 || std::strcmp(argv[1], "encode") != 0) {
        std::fprintf(
            stderr,
            "usage: %s encode <in.y4m> <out.pwv> [--mbps 170] [--packet 1100] [--vendor 0x10de] "
            "[--repeat N]\n",
            argv[0]);
        return 1;
    }
    double mbps = 170;
    size_t packet = 1100;
    uint32_t vendor = 0;
    int repeat = 0;
    bool debug = false;
    const char* dumpCoef = nullptr;
    bool selfTest = false;
    bool nv12 = false;
    for (int i = 4; i < argc; i++)
        if (!std::strcmp(argv[i], "--debug"))
            debug = true;
        else if (!std::strcmp(argv[i], "--selftest"))
            selfTest = true;
        else if (!std::strcmp(argv[i], "--nv12"))
            nv12 = true;
    for (int i = 4; i + 1 < argc; i += 2) {
        if (!std::strcmp(argv[i], "--mbps"))
            mbps = std::atof(argv[i + 1]);
        else if (!std::strcmp(argv[i], "--packet"))
            packet = size_t(std::atoi(argv[i + 1]));
        else if (!std::strcmp(argv[i], "--vendor"))
            vendor = uint32_t(std::strtoul(argv[i + 1], nullptr, 0));
        else if (!std::strcmp(argv[i], "--dump-coef"))
            dumpCoef = argv[i + 1];
        else if (!std::strcmp(argv[i], "--repeat"))
            repeat = std::atoi(argv[i + 1]);
    }
    return encode(argv[2], argv[3], mbps, packet, vendor, repeat, debug, dumpCoef, selfTest, nv12);
}
