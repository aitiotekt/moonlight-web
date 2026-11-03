// mw-pyrowave-ref — the reference PyroWave codec (upstream, Vulkan) as an
// oracle for the POC Ultra ports. See ../CMakeLists.txt.
//
//   mw-pyrowave-ref encode <in.y4m> <out.pwv> [--mbps 170] [--packet 1100] [--vendor 0x10de]
//   mw-pyrowave-ref decode <in.pwv> <out.y4m> [--vendor 0x8086]
//   mw-pyrowave-ref psnr   <a.y4m> <b.y4m>
//
// Only 8-bit 4:2:0 Y4M. A .pwv file is the stream as it would travel:
//   "PWV1", u32 width, u32 height, u32 fps_num, u32 fps_den, u32 frames,
//   then per frame u32 packet count and, per packet, u32 size + the bytes.
// Every line of output is a JSON object, so a script can read it.

#include "volk.h"
#include "pyrowave.h"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

struct Y4m
{
    FILE* f = nullptr;
    int width = 0, height = 0, fpsNum = 60, fpsDen = 1;
    size_t frameBytes() const { return size_t(width) * height * 3 / 2; }
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
        else if (tok[0] == 'C' && std::strncmp(tok + 1, "420", 3) != 0) {
            std::fprintf(stderr, "only 4:2:0 8-bit Y4M (got C%s)\n", tok + 1);
            return false;
        }
    }
    return y.width > 0 && y.height > 0;
}

bool readFrame(Y4m& y, std::vector<uint8_t>& buf)
{
    char line[128];
    if (!std::fgets(line, sizeof line, y.f) || std::strncmp(line, "FRAME", 5) != 0) return false;
    buf.resize(y.frameBytes());
    return std::fread(buf.data(), 1, buf.size(), y.f) == buf.size();
}

pyrowave_cpu_buffer cpuBuffer(std::vector<uint8_t>& frame, int w, int h)
{
    pyrowave_cpu_buffer b = {};
    const size_t ySize = size_t(w) * h, cSize = ySize / 4;
    b.data[0] = frame.data();
    b.data[1] = frame.data() + ySize;
    b.data[2] = frame.data() + ySize + cSize;
    b.row_stride_in_bytes[0] = w;
    b.row_stride_in_bytes[1] = b.row_stride_in_bytes[2] = w / 2;
    b.plane_size_in_bytes[0] = ySize;
    b.plane_size_in_bytes[1] = b.plane_size_in_bytes[2] = cSize;
    b.width = w;
    b.height = h;
    b.format = PYROWAVE_CPU_BUFFER_FORMAT_YUV420P;
    return b;
}

void put32(FILE* f, uint32_t v)
{
    std::fwrite(&v, 4, 1, f);
}
bool get32(FILE* f, uint32_t& v)
{
    return std::fread(&v, 4, 1, f) == 1;
}

// The GPU by PCI vendor id (0x10de NVIDIA, 0x8086 Intel, 0x1002 AMD), or the
// library's first choice. Implicit Vulkan layers are turned off: one of this
// machine's (a capture layer) crashes the device creation, and an oracle has
// no use for them.
pyrowave_device openDevice(uint32_t vendor)
{
#ifdef _WIN32
    _putenv_s("VK_LOADER_LAYERS_DISABLE", "~implicit~");
#endif
    pyrowave_device dev = nullptr;
    if (pyrowave_create_device_by_compat(vendor, 0, nullptr, nullptr, nullptr, &dev) !=
        PYROWAVE_SUCCESS)
        return nullptr;
    VkPhysicalDevice gpu = VK_NULL_HANDLE;
    pyrowave_device_get_vk_device_handles(dev, nullptr, &gpu, nullptr);
    VkPhysicalDeviceProperties props = {};
    vkGetPhysicalDeviceProperties(gpu, &props);
    std::printf("{\"gpu_name\":\"%s\",\"vendor\":\"0x%04x\"}\n", props.deviceName, props.vendorID);
    return dev;
}

double ms(std::chrono::steady_clock::duration d)
{
    return std::chrono::duration<double, std::milli>(d).count();
}

// The device's GPU timestamps, one JSON line per message.
void perfLine(void*, const char* msg)
{
    std::string s(msg);
    for (auto& c : s)
        if (c == '"' || c == '\n') c = ' ';
    std::printf("{\"gpu\":\"%s\"}\n", s.c_str());
}

int encode(const char* in, const char* out, double mbps, size_t packetSize, uint32_t vendor)
{
    Y4m y;
    if (!openY4m(y, in)) return std::fprintf(stderr, "cannot read %s\n", in), 2;
    pyrowave_device dev = openDevice(vendor);
    if (!dev) return std::fprintf(stderr, "no Vulkan device\n"), 3;
    pyrowave_encoder_create_info ci = {dev, y.width, y.height, PYROWAVE_CHROMA_SUBSAMPLING_420};
    pyrowave_encoder enc = nullptr;
    if (pyrowave_encoder_create(&ci, &enc) != PYROWAVE_SUCCESS)
        return std::fprintf(stderr, "encoder refused %dx%d\n", y.width, y.height), 3;

    FILE* o = std::fopen(out, "wb");
    if (!o) return std::fprintf(stderr, "cannot write %s\n", out), 2;
    std::fwrite("PWV1", 1, 4, o);
    for (uint32_t v :
         {uint32_t(y.width), uint32_t(y.height), uint32_t(y.fpsNum), uint32_t(y.fpsDen), 0u})
        put32(o, v);

    const double fps = double(y.fpsNum) / y.fpsDen;
    pyrowave_rate_control rc = {size_t(mbps * 1e6 / 8.0 / fps)};
    std::vector<uint8_t> frame, bits;
    std::vector<pyrowave_packet> packets;
    uint32_t frames = 0;
    double bytesTotal = 0;
    while (readFrame(y, frame)) {
        pyrowave_cpu_buffer b = cpuBuffer(frame, y.width, y.height);
        const auto t0 = std::chrono::steady_clock::now();
        if (pyrowave_encoder_encode_cpu_synchronous(enc, &b, &rc) != PYROWAVE_SUCCESS)
            return std::fprintf(stderr, "encode failed at frame %u\n", frames), 4;
        size_t n = 0;
        pyrowave_encoder_compute_num_packets(enc, packetSize, &n);
        packets.resize(n);
        bits.resize(rc.maximum_bitstream_size + n * 64 + 4096);
        size_t got = 0;
        if (pyrowave_encoder_packetize(enc, packets.data(), packetSize, &got, bits.data(),
                                       bits.size()) != PYROWAVE_SUCCESS)
            return std::fprintf(stderr, "packetize failed at frame %u\n", frames), 4;
        const double wall = ms(std::chrono::steady_clock::now() - t0);
        size_t bytes = 0;
        put32(o, uint32_t(got));
        for (size_t i = 0; i < got; i++) {
            put32(o, uint32_t(packets[i].size));
            std::fwrite(bits.data() + packets[i].offset, 1, packets[i].size, o);
            bytes += packets[i].size;
        }
        bytesTotal += bytes;
        std::printf("{\"frame\":%u,\"bytes\":%zu,\"packets\":%zu,\"wall_ms\":%.3f}\n", frames,
                    bytes, got, wall);
        frames++;
    }
    std::fseek(o, 4 + 4 * 4, SEEK_SET);
    put32(o, frames);
    std::fclose(o);
    pyrowave_device_report_performance_stats(dev, perfLine, nullptr, true);
    std::printf(
        "{\"done\":\"encode\",\"frames\":%u,\"width\":%d,\"height\":%d,\"target_mbps\":%.1f,"
        "\"mean_mbps\":%.2f}\n",
        frames, y.width, y.height, mbps, frames ? bytesTotal * 8 * fps / frames / 1e6 : 0.0);
    pyrowave_encoder_destroy(enc);
    pyrowave_device_destroy(dev);
    return 0;
}

int decode(const char* in, const char* out, uint32_t vendor)
{
    FILE* f = std::fopen(in, "rb");
    char magic[4];
    uint32_t w, h, fn, fd, frames;
    if (!f || std::fread(magic, 1, 4, f) != 4 || std::memcmp(magic, "PWV1", 4) != 0 ||
        !get32(f, w) || !get32(f, h) || !get32(f, fn) || !get32(f, fd) || !get32(f, frames))
        return std::fprintf(stderr, "cannot read %s\n", in), 2;
    pyrowave_device dev = openDevice(vendor);
    if (!dev) return std::fprintf(stderr, "no Vulkan device\n"), 3;
    pyrowave_decoder_create_info ci = {dev, int(w), int(h), PYROWAVE_CHROMA_SUBSAMPLING_420, false};
    pyrowave_decoder decd = nullptr;
    if (pyrowave_decoder_create(&ci, &decd) != PYROWAVE_SUCCESS)
        return std::fprintf(stderr, "decoder refused %ux%u\n", w, h), 3;
    FILE* o = std::fopen(out, "wb");
    if (!o) return std::fprintf(stderr, "cannot write %s\n", out), 2;
    std::fprintf(o, "YUV4MPEG2 W%u H%u F%u:%u Ip A1:1 C420jpeg\n", w, h, fn, fd);

    std::vector<uint8_t> frame(size_t(w) * h * 3 / 2), pkt;
    for (uint32_t i = 0; i < frames; i++) {
        uint32_t n = 0;
        if (!get32(f, n)) return std::fprintf(stderr, "truncated at frame %u\n", i), 4;
        const auto t0 = std::chrono::steady_clock::now();
        for (uint32_t p = 0; p < n; p++) {
            uint32_t size = 0;
            get32(f, size);
            pkt.resize(size);
            if (std::fread(pkt.data(), 1, size, f) != size)
                return std::fprintf(stderr, "truncated\n"), 4;
            pyrowave_decoder_push_packet(decd, pkt.data(), pkt.size());
        }
        const bool ready = pyrowave_decoder_decode_is_ready(decd, false);
        pyrowave_cpu_buffer b = cpuBuffer(frame, int(w), int(h));
        if (pyrowave_decoder_decode_cpu_buffer_synchronous(decd, &b) != PYROWAVE_SUCCESS)
            return std::fprintf(stderr, "decode failed at frame %u\n", i), 4;
        std::printf("{\"frame\":%u,\"complete\":%s,\"wall_ms\":%.3f}\n", i,
                    ready ? "true" : "false", ms(std::chrono::steady_clock::now() - t0));
        std::fputs("FRAME\n", o);
        std::fwrite(frame.data(), 1, frame.size(), o);
    }
    std::fclose(o);
    pyrowave_device_report_performance_stats(dev, perfLine, nullptr, true);
    std::printf("{\"done\":\"decode\",\"frames\":%u}\n", frames);
    pyrowave_decoder_destroy(decd);
    pyrowave_device_destroy(dev);
    return 0;
}

double psnrPlane(const uint8_t* a, const uint8_t* b, size_t n, int* maxDiff)
{
    double se = 0;
    for (size_t i = 0; i < n; i++) {
        const int d = int(a[i]) - int(b[i]);
        se += double(d) * d;
        if (std::abs(d) > *maxDiff) *maxDiff = std::abs(d);
    }
    return se == 0 ? 99.0 : 10.0 * std::log10(255.0 * 255.0 * n / se);
}

int psnr(const char* pa, const char* pb)
{
    Y4m a, b;
    if (!openY4m(a, pa) || !openY4m(b, pb) || a.width != b.width || a.height != b.height)
        return std::fprintf(stderr, "cannot compare %s and %s\n", pa, pb), 2;
    std::vector<uint8_t> fa, fb;
    const size_t ySize = size_t(a.width) * a.height, cSize = ySize / 4;
    double sumY = 0, sumU = 0, sumV = 0, minY = 99;
    int frames = 0, maxDiff = 0;
    while (readFrame(a, fa) && readFrame(b, fb)) {
        int md = 0;
        const double y = psnrPlane(fa.data(), fb.data(), ySize, &md);
        const double u = psnrPlane(fa.data() + ySize, fb.data() + ySize, cSize, &md);
        const double v =
            psnrPlane(fa.data() + ySize + cSize, fb.data() + ySize + cSize, cSize, &md);
        std::printf(
            "{\"frame\":%d,\"psnr_y\":%.3f,\"psnr_u\":%.3f,\"psnr_v\":%.3f,\"max_diff\":%d}\n",
            frames, y, u, v, md);
        sumY += y, sumU += u, sumV += v;
        if (y < minY) minY = y;
        if (md > maxDiff) maxDiff = md;
        frames++;
    }
    if (!frames) return std::fprintf(stderr, "no frames\n"), 4;
    std::printf("{\"done\":\"psnr\",\"frames\":%d,\"psnr_y\":%.3f,\"psnr_u\":%.3f,\"psnr_v\":%.3f,"
                "\"min_psnr_y\":%.3f,\"max_diff\":%d}\n",
                frames, sumY / frames, sumU / frames, sumV / frames, minY, maxDiff);
    return 0;
}

} // namespace

int main(int argc, char** argv)
{
    std::setvbuf(stdout, nullptr, _IONBF, 0); // a crash keeps the lines before it
    if (argc < 4) {
        std::fprintf(stderr, "usage: %s encode|decode|psnr <in> <out> [--mbps N] [--packet B]\n",
                     argv[0]);
        return 1;
    }
    double mbps = 170;
    size_t packet = 1100;
    uint32_t vendor = 0;
    for (int i = 4; i + 1 < argc; i += 2) {
        if (!std::strcmp(argv[i], "--mbps"))
            mbps = std::atof(argv[i + 1]);
        else if (!std::strcmp(argv[i], "--packet"))
            packet = size_t(std::atoi(argv[i + 1]));
        else if (!std::strcmp(argv[i], "--vendor"))
            vendor = uint32_t(std::strtoul(argv[i + 1], nullptr, 0));
    }
    const std::string cmd = argv[1];
    if (cmd == "encode") return encode(argv[2], argv[3], mbps, packet, vendor);
    if (cmd == "decode") return decode(argv[2], argv[3], vendor);
    if (cmd == "psnr") return psnr(argv[2], argv[3]);
    std::fprintf(stderr, "unknown command %s\n", cmd.c_str());
    return 1;
}
