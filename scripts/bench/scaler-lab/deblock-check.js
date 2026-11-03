// mwsr 2 and 3's deblocking (frontend DeblockShader.js) on the software
// adapter, driven by deblock_check.py:
//   - its two passes alone on a decoded frame (?img=), at the strengths of
//     mwsr 2 (t8c2) and of mwsr 3 at QP 36 (t12c4) and 22, read back for the
//     driver to hold against numpy (p8/p8_filters.py's dct_shrink);
//   - the product's WebGpuRenderer drawing that frame with algo 'mwsr' and
//     deblock null, 'fixed' and 'qp': no WebGPU error, the frame it deblocked
//     the same as the passes alone, its picture moved a little from plain
//     mwsr's, and mwsr 3's frame of QP 18 (no pass) the same as plain mwsr's.
// The page refuses any adapter but SwiftShader before it asks for a device.
// Its answer is left in window.__done.
import {
    DEBLOCK_DCT_WGSL,
    DEBLOCK_FIN_WGSL,
    deblockDispatch,
    deblockStrength,
    deblockUniforms,
} from "../../../frontend/js/stream/renderers/DeblockShader.js";
import { WebGpuRenderer } from "../../../frontend/js/stream/renderers/WebGpuRenderer.js";

const q = new URLSearchParams(location.search);
const OUT_W = 2560;
const OUT_H = 1440;
const T = GPUTextureUsage;
const B = GPUBufferUsage;

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A texture's RGBA8 bytes (rows packed), read through a copy texture. */
async function readTexture(device, view, w, h) {
  const copy = device.createTexture({
    size: [w, h],
    format: "rgba8unorm",
    usage: T.RENDER_ATTACHMENT | T.COPY_SRC,
  });
  const module = device.createShaderModule({
    code: /* wgsl */ `
@group(0) @binding(0) var src : texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
    let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p : vec4f) -> @location(0) vec4f {
    return textureLoad(src, vec2i(p.xy), 0);
}`,
  });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
  });
  const buf = device.createBuffer({ size: w * h * 4, usage: B.COPY_DST | B.MAP_READ });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: copy.createView(), loadOp: "clear", storeOp: "store" }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: view }],
    }),
  );
  pass.draw(3);
  pass.end();
  enc.copyTextureToBuffer({ texture: copy }, { buffer: buf, bytesPerRow: w * 4 }, [w, h]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const out = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap();
  buf.destroy();
  copy.destroy();
  return out;
}

/** The two passes alone, as WebGpuRenderer runs them, on `src` (w×h). */
async function deblockAlone(device, src, w, h, s) {
  const layout = (visibility, type) =>
    device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility, texture: { sampleType: "float" } },
        { binding: 1, visibility, buffer: { type } },
        { binding: 2, visibility, buffer: { type: "uniform" } },
      ],
    });
  const dctLayout = layout(GPUShaderStage.COMPUTE, "storage");
  const finLayout = layout(GPUShaderStage.FRAGMENT, "read-only-storage");
  const dct = device.createShaderModule({ code: DEBLOCK_DCT_WGSL });
  const fin = device.createShaderModule({ code: DEBLOCK_FIN_WGSL });
  const pDct = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [dctLayout] }),
    compute: { module: dct, entryPoint: "cs" },
  });
  const pFin = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [finLayout] }),
    vertex: { module: fin, entryPoint: "vs" },
    fragment: { module: fin, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
  });
  const acc = device.createBuffer({ size: w * h * 4, usage: B.STORAGE | B.COPY_DST });
  const uni = device.createBuffer({ size: 16, usage: B.UNIFORM | B.COPY_DST });
  device.queue.writeBuffer(uni, 0, deblockUniforms(w, h, s));
  const dst = device.createTexture({
    size: [w, h],
    format: "rgba8unorm",
    usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING,
  });
  const entries = [
    { binding: 0, resource: src.createView() },
    { binding: 1, resource: { buffer: acc } },
    { binding: 2, resource: { buffer: uni } },
  ];
  const enc = device.createCommandEncoder();
  enc.clearBuffer(acc);
  const pc = enc.beginComputePass();
  pc.setPipeline(pDct);
  pc.setBindGroup(0, device.createBindGroup({ layout: dctLayout, entries }));
  pc.dispatchWorkgroups(...deblockDispatch(w, h));
  pc.end();
  const pd = enc.beginRenderPass({
    colorAttachments: [{ view: dst.createView(), loadOp: "clear", storeOp: "store" }],
  });
  pd.setPipeline(pFin);
  pd.setBindGroup(0, device.createBindGroup({ layout: finLayout, entries }));
  pd.draw(3);
  pd.end();
  device.queue.submit([enc.finish()]);
  const bytes = await readTexture(device, dst.createView(), w, h);
  acc.destroy();
  uni.destroy();
  dst.destroy();
  return bytes;
}

/** The canvas' current picture as RGBA bytes. */
function canvasBytes(canvas) {
  const bmp = canvas.transferToImageBitmap();
  const c2 = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c2.getContext("2d");
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return g.getImageData(0, 0, c2.width, c2.height).data;
}

function compare(a, b) {
  let max = 0;
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if ((i & 3) === 3) continue;
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    sum += d;
    sq += d * d;
    n++;
  }
  const mse = sq / n;
  return {
    max,
    mean: sum / n,
    psnr: mse ? 10 * Math.log10((255 * 255) / mse) : Infinity,
  };
}

async function main() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no adapter");
  const info = adapter.info || {};
  const name = [info.vendor, info.architecture, info.device, info.description].join(" ");
  if (!/swiftshader/i.test(name)) throw new Error("not the software adapter: " + name);
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener("uncapturederror", (e) => errors.push(String(e.error.message)));

  const blob = await (await fetch(q.get("img"))).blob();
  const bmp = await createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const w = bmp.width;
  const h = bmp.height;
  const src = device.createTexture({
    size: [w, h],
    format: "rgba8unorm",
    usage: T.TEXTURE_BINDING | T.COPY_DST | T.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: bmp }, { texture: src }, [w, h]);

  // The passes alone.
  const cases = { fixed: deblockStrength("fixed", null), qp36: deblockStrength("qp", 36), qp22: deblockStrength("qp", 22) };
  const alone = {};
  const aloneBytes = {};
  const input = await readTexture(device, src.createView(), w, h);
  for (const [k, s] of Object.entries(cases)) {
    const t0 = performance.now();
    aloneBytes[k] = await deblockAlone(device, src, w, h, s);
    alone[k] = {
      strength: s,
      ms: performance.now() - t0,
      vsInput: compare(aloneBytes[k], input),
      rgba: b64(aloneBytes[k]),
    };
  }

  // The renderer's draw path.
  const renderer = {};
  let plain = null;
  for (const mode of [null, "fixed", "qp"]) {
    const canvas = new OffscreenCanvas(16, 16);
    const r = await WebGpuRenderer.create(canvas, {
      algo: "mwsr",
      deblock: mode,
      videoCodec: "h264",
    });
    const rErrors = [];
    r._device.addEventListener("uncapturederror", (e) => rErrors.push(String(e.error.message)));
    r.setOutputSize(OUT_W, OUT_H);
    const out = { wantsFrameQp: r.wantsFrameQp, draws: [] };
    const frames = mode === "qp" ? [[1000, 36], [2000, 18]] : [[1000, null]];
    for (const [ts, qp] of frames) {
      if (mode === "qp") r.noteFrameQp(ts, qp);
      await r.draw(new VideoFrame(bmp, { timestamp: ts }));
      const pic = canvasBytes(canvas);
      const d = { ts, qp, deblockLast: r.deblockLast, size: [canvas.width, canvas.height] };
      if (!mode) plain = pic;
      else d.vsPlain = compare(pic, plain);
      if (mode && r._dbTex && r.deblockLast && r.deblockLast.thr) {
        const db = await readTexture(r._device, r._dbTex.createView(), w, h);
        d.dbTexVsAlone = compare(db, aloneBytes[mode === "qp" ? "qp36" : "fixed"]);
      }
      out.draws.push(d);
    }
    out.failed = r.failed;
    out.errors = rErrors;
    renderer[mode || "plain"] = out;
    r.dispose();
  }
  return { ok: true, adapter: name, size: [w, h], errors, alone, renderer };
}

main()
  .then((r) => {
    window.__done = r;
  })
  .catch((e) => {
    window.__done = { ok: false, error: String((e && e.stack) || e) };
  });
