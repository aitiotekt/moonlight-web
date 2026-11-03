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

/**
 * The quantiser a frame was encoded with, read from its first slice header:
 * what mwsr's version 3 sets its deblocking from (DeblockShader.js,
 * docs/design/upscaler-mwsr.md §14.7). The host's encoder writes it into
 * every frame — 26 + the PPS's init_qp_minus26 + the slice's slice_qp_delta —
 * so it reaches the client with Sunshine, Apollo, Wolf or the native host
 * alike, and no message of our own has to carry it.
 *
 * The slice QP is the frame's base: an encoder's adaptive quantisation moves
 * each block around it, which is close enough to set a strength by.
 *
 * H.264 (ITU-T H.264 §7.3.2.1.1, §7.3.2.2, §7.3.3) and HEVC (ITU-T H.265
 * §7.3.2.2, §7.3.2.3, §7.3.6.1), read up to slice_qp_delta. What this does not
 * read gives null, never a wrong value: H.264's slice groups (FMO, Baseline
 * only) and data partitions, HEVC's screen-content and multi-layer
 * extensions, and AV1 (its base_q_idx sits behind a much longer header).
 */

const H264_SLICE = 1;
const H264_IDR = 5;
const H264_SPS = 7;
const H264_PPS = 8;
const HEVC_SPS = 33;
const HEVC_PPS = 34;

/** A slice header fits in far less; what is cut off reads as an overrun. */
const SLICE_HEADER_BYTES = 512;

/** H.264 profiles whose SPS carries chroma_format_idc and the bit depths. */
const H264_HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/**
 * The RBSP of a NAL unit from byte `from` (the header skipped), its
 * emulation-prevention bytes taken out, at most `max` bytes of it.
 * @param {Uint8Array} nal
 * @param {number} from
 * @param {number} max
 * @returns {Uint8Array}
 */
function rbsp(nal, from, max) {
    const out = new Uint8Array(Math.min(max, nal.length - from));
    let n = 0;
    let zeros = 0;
    for (let i = from; i < nal.length && n < out.length; i++) {
        const b = nal[i];
        if (zeros >= 2 && b === 3) {
            zeros = 0;
            continue;
        }
        zeros = b === 0 ? zeros + 1 : 0;
        out[n++] = b;
    }
    return out.subarray(0, n);
}

/** Exp-Golomb bit reader over an RBSP; reading past its end throws. */
class Bits {
    constructor(bytes) {
        this.bytes = bytes;
        this.pos = 0;
    }
    u(n) {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const at = this.pos >> 3;
            if (at >= this.bytes.length) throw new Error('slice header overrun');
            v = v * 2 + ((this.bytes[at] >> (7 - (this.pos & 7))) & 1);
            this.pos++;
        }
        return v;
    }
    skip(n) {
        if ((this.pos + n + 7) >> 3 > this.bytes.length) throw new Error('slice header overrun');
        this.pos += n;
    }
    ue() {
        let zeros = 0;
        while (this.u(1) === 0) {
            if (++zeros > 31) throw new Error('exp-Golomb overrun');
        }
        return zeros ? 2 ** zeros - 1 + this.u(zeros) : 0;
    }
    se() {
        const k = this.ue();
        return k & 1 ? (k + 1) / 2 : -(k / 2);
    }
}

/** Ceil(Log2(n)), the width of an index among n. */
function ceilLog2(n) {
    let bits = 0;
    while (2 ** bits < n) bits++;
    return bits;
}

// ── H.264 ────────────────────────────────────────────────────────────────

function h264Sps(nal) {
    const r = new Bits(rbsp(nal, 1, nal.length));
    const profile = r.u(8);
    r.skip(16); // constraint flags, level_idc
    const id = r.ue();
    let chromaFormat = 1;
    let separatePlanes = 0;
    if (H264_HIGH_PROFILES.includes(profile)) {
        chromaFormat = r.ue();
        if (chromaFormat === 3) separatePlanes = r.u(1);
        r.ue(); // bit_depth_luma_minus8
        r.ue(); // bit_depth_chroma_minus8
        r.u(1); // qpprime_y_zero_transform_bypass_flag
        if (r.u(1)) {
            // seq_scaling_matrix_present_flag: the lists, read past
            const lists = chromaFormat === 3 ? 12 : 8;
            for (let i = 0; i < lists; i++) {
                if (!r.u(1)) continue;
                const size = i < 6 ? 16 : 64;
                let last = 8;
                let next = 8;
                for (let j = 0; j < size && next !== 0; j++) {
                    next = (last + r.se() + 256) % 256;
                    if (next !== 0) last = next;
                }
            }
        }
    }
    const frameNumBits = r.ue() + 4;
    const pocType = r.ue();
    let pocLsbBits = 0;
    let deltaPocAlwaysZero = 0;
    if (pocType === 0) {
        pocLsbBits = r.ue() + 4;
    } else if (pocType === 1) {
        deltaPocAlwaysZero = r.u(1);
        r.se(); // offset_for_non_ref_pic
        r.se(); // offset_for_top_to_bottom_field
        const cycle = r.ue();
        for (let i = 0; i < cycle; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.u(1); // gaps_in_frame_num_value_allowed_flag
    r.ue(); // pic_width_in_mbs_minus1
    r.ue(); // pic_height_in_map_units_minus1
    const frameMbsOnly = r.u(1);
    return {
        id,
        chromaArrayType: separatePlanes ? 0 : chromaFormat,
        separatePlanes,
        frameNumBits,
        pocType,
        pocLsbBits,
        deltaPocAlwaysZero,
        frameMbsOnly,
    };
}

function h264Pps(nal) {
    const r = new Bits(rbsp(nal, 1, nal.length));
    const id = r.ue();
    const spsId = r.ue();
    const cabac = r.u(1);
    const bottomFieldPocPresent = r.u(1);
    // Slice groups (FMO): Baseline's, never seen from a game host. Unread.
    if (r.ue() !== 0) return { id, unsupported: true };
    const refL0 = r.ue() + 1;
    const refL1 = r.ue() + 1;
    const weightedPred = r.u(1);
    const weightedBipred = r.u(2);
    const initQp = 26 + r.se();
    // pic_init_qs, chroma_qp_index_offset, deblocking_filter_control_present,
    // constrained_intra_pred_flag
    pass(r, 'se', 'se', 'u1', 'u1');
    const redundantPicCnt = r.u(1);
    return {
        id,
        spsId,
        cabac,
        bottomFieldPocPresent,
        refL0,
        refL1,
        weightedPred,
        weightedBipred,
        initQp,
        redundantPicCnt,
    };
}

/** Reads past `fields`: 'se', 'ue' or 'u1' each. */
function pass(r, ...fields) {
    for (const f of fields) {
        if (f === 'se') r.se();
        else if (f === 'ue') r.ue();
        else r.u(1);
    }
}

function h264Weights(r, refs, chroma) {
    for (let i = 0; i < refs; i++) {
        if (r.u(1)) pass(r, 'se', 'se'); // luma weight, offset
        if (chroma && r.u(1)) pass(r, 'se', 'se', 'se', 'se');
    }
}

function h264SliceQp(nal, spss, ppss) {
    const type = nal[0] & 0x1f;
    const refIdc = (nal[0] >> 5) & 3;
    const r = new Bits(rbsp(nal, 1, SLICE_HEADER_BYTES));
    r.ue(); // first_mb_in_slice
    const sliceType = r.ue() % 5; // 0 P, 1 B, 2 I, 3 SP, 4 SI
    const pps = ppss.get(r.ue());
    if (!pps || pps.unsupported) return null;
    const sps = spss.get(pps.spsId);
    if (!sps) return null;
    if (sps.separatePlanes) r.u(2); // colour_plane_id
    r.skip(sps.frameNumBits); // frame_num
    let field = 0;
    if (!sps.frameMbsOnly) {
        field = r.u(1);
        if (field) r.u(1); // bottom_field_flag
    }
    if (type === H264_IDR) r.ue(); // idr_pic_id
    if (sps.pocType === 0) {
        r.skip(sps.pocLsbBits);
        if (pps.bottomFieldPocPresent && !field) r.se();
    } else if (sps.pocType === 1 && !sps.deltaPocAlwaysZero) {
        r.se();
        if (pps.bottomFieldPocPresent && !field) r.se();
    }
    if (pps.redundantPicCnt) r.ue();
    const isB = sliceType === 1;
    const isP = sliceType === 0 || sliceType === 3;
    if (isB) r.u(1); // direct_spatial_mv_pred_flag
    let refL0 = pps.refL0;
    let refL1 = pps.refL1;
    if (isP || isB) {
        if (r.u(1)) {
            refL0 = r.ue() + 1;
            if (isB) refL1 = r.ue() + 1;
        }
    }
    // ref_pic_list_modification (every slice but I and SI)
    const lists = sliceType === 2 || sliceType === 4 ? 0 : isB ? 2 : 1;
    for (let list = 0; list < lists; list++) {
        if (!r.u(1)) continue;
        for (;;) {
            const idc = r.ue();
            if (idc === 3) break;
            if (idc > 5) return null;
            r.ue(); // abs_diff_pic_num_minus1, long_term_pic_num or abs_diff_view_idx
        }
    }
    if ((pps.weightedPred && isP) || (pps.weightedBipred === 1 && isB)) {
        r.ue(); // luma_log2_weight_denom
        if (sps.chromaArrayType !== 0) r.ue();
        h264Weights(r, refL0, sps.chromaArrayType !== 0);
        if (isB) h264Weights(r, refL1, sps.chromaArrayType !== 0);
    }
    if (refIdc !== 0) {
        if (type === H264_IDR) {
            r.u(2); // no_output_of_prior_pics_flag, long_term_reference_flag
        } else if (r.u(1)) {
            // adaptive_ref_pic_marking_mode_flag: the operations, read past
            for (;;) {
                const op = r.ue();
                if (op === 0) break;
                if (op > 6) return null;
                if (op === 1 || op === 3) r.ue();
                if (op === 2) r.ue();
                if (op === 3 || op === 6) r.ue();
                if (op === 4) r.ue();
            }
        }
    }
    if (pps.cabac && sliceType !== 2 && sliceType !== 4) r.ue(); // cabac_init_idc
    return pps.initQp + r.se();
}

// ── HEVC ─────────────────────────────────────────────────────────────────

function hevcProfileTierLevel(r, maxSubLayersMinus1) {
    r.skip(88); // general profile space … constraint flags
    r.skip(8); // general_level_idc
    const profile = [];
    const level = [];
    for (let i = 0; i < maxSubLayersMinus1; i++) {
        profile.push(r.u(1));
        level.push(r.u(1));
    }
    if (maxSubLayersMinus1 > 0) r.skip(2 * (8 - maxSubLayersMinus1));
    for (let i = 0; i < maxSubLayersMinus1; i++) {
        if (profile[i]) r.skip(88);
        if (level[i]) r.skip(8);
    }
}

function hevcScalingListData(r) {
    for (let size = 0; size < 4; size++) {
        for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
            if (!r.u(1)) {
                r.ue(); // scaling_list_pred_matrix_id_delta
                continue;
            }
            const coefs = Math.min(64, 1 << (4 + (size << 1)));
            if (size > 1) r.se(); // scaling_list_dc_coef_minus8
            for (let i = 0; i < coefs; i++) r.se();
        }
    }
}

/**
 * st_ref_pic_set(idx): the set's two lists, each entry {d: delta POC, used},
 * `sets` the SPS's sets already read (the ones a set may be predicted from).
 */
function hevcShortTermRps(r, idx, count, sets) {
    if (idx !== 0 && r.u(1)) {
        // inter_ref_pic_set_prediction_flag: derived from a set before it (7-61, 7-62)
        const delta = idx === count ? r.ue() + 1 : 1;
        const ref = sets[idx - delta];
        if (!ref) throw new Error('reference picture set out of range');
        const sign = r.u(1);
        const deltaRps = (1 - 2 * sign) * (r.ue() + 1);
        const n = ref.s0.length + ref.s1.length;
        const used = [];
        const use = [];
        for (let j = 0; j <= n; j++) {
            used.push(r.u(1));
            use.push(used[j] ? 1 : r.u(1));
        }
        const neg = ref.s0.length;
        const s0 = [];
        const s1 = [];
        for (let j = ref.s1.length - 1; j >= 0; j--) {
            const d = ref.s1[j].d + deltaRps;
            if (d < 0 && use[neg + j]) s0.push({ d, used: used[neg + j] });
        }
        if (deltaRps < 0 && use[n]) s0.push({ d: deltaRps, used: used[n] });
        for (let j = 0; j < neg; j++) {
            const d = ref.s0[j].d + deltaRps;
            if (d < 0 && use[j]) s0.push({ d, used: used[j] });
        }
        for (let j = neg - 1; j >= 0; j--) {
            const d = ref.s0[j].d + deltaRps;
            if (d > 0 && use[j]) s1.push({ d, used: used[j] });
        }
        if (deltaRps > 0 && use[n]) s1.push({ d: deltaRps, used: used[n] });
        for (let j = 0; j < ref.s1.length; j++) {
            const d = ref.s1[j].d + deltaRps;
            if (d > 0 && use[neg + j]) s1.push({ d, used: used[neg + j] });
        }
        return { s0, s1 };
    }
    const negatives = r.ue();
    const positives = r.ue();
    if (negatives > 16 || positives > 16) throw new Error('reference picture set too long');
    const s0 = [];
    const s1 = [];
    let poc = 0;
    for (let i = 0; i < negatives; i++) {
        poc -= r.ue() + 1;
        s0.push({ d: poc, used: r.u(1) });
    }
    poc = 0;
    for (let i = 0; i < positives; i++) {
        poc += r.ue() + 1;
        s1.push({ d: poc, used: r.u(1) });
    }
    return { s0, s1 };
}

function hevcSps(nal) {
    const r = new Bits(rbsp(nal, 2, nal.length));
    r.u(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = r.u(3);
    r.u(1); // sps_temporal_id_nesting_flag
    hevcProfileTierLevel(r, maxSubLayersMinus1);
    const id = r.ue();
    const chromaFormat = r.ue();
    const separatePlanes = chromaFormat === 3 ? r.u(1) : 0;
    r.ue(); // pic_width_in_luma_samples
    r.ue(); // pic_height_in_luma_samples
    if (r.u(1)) pass(r, 'ue', 'ue', 'ue', 'ue'); // conformance window
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    const pocLsbBits = r.ue() + 4;
    const orderingAll = r.u(1);
    for (let i = orderingAll ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
        pass(r, 'ue', 'ue', 'ue');
    }
    for (let i = 0; i < 6; i++) r.ue(); // block sizes, transform depths
    if (r.u(1) && r.u(1)) hevcScalingListData(r); // scaling list enabled, data present
    r.u(1); // amp_enabled_flag
    const sao = r.u(1);
    if (r.u(1)) {
        // pcm_enabled_flag
        r.u(8);
        pass(r, 'ue', 'ue', 'u1');
    }
    const setCount = r.ue();
    if (setCount > 64) throw new Error('too many reference picture sets');
    const sets = [];
    for (let i = 0; i < setCount; i++) sets.push(hevcShortTermRps(r, i, setCount, sets));
    const longTermPresent = r.u(1);
    const longTermUsed = [];
    if (longTermPresent) {
        const n = r.ue();
        for (let i = 0; i < n; i++) {
            r.skip(pocLsbBits);
            longTermUsed.push(r.u(1));
        }
    }
    return {
        id,
        chromaArrayType: separatePlanes ? 0 : chromaFormat,
        separatePlanes,
        pocLsbBits,
        sao,
        sets,
        longTermPresent,
        longTermUsed,
        temporalMvp: r.u(1),
    };
}

function hevcPps(nal) {
    const r = new Bits(rbsp(nal, 2, nal.length));
    const pps = {
        id: r.ue(),
        spsId: r.ue(),
        dependentSlices: r.u(1),
        outputFlagPresent: r.u(1),
        extraSliceHeaderBits: r.u(3),
    };
    r.u(1); // sign_data_hiding_enabled_flag
    pps.cabacInitPresent = r.u(1);
    pps.refL0 = r.ue() + 1;
    pps.refL1 = r.ue() + 1;
    pps.initQp = 26 + r.se();
    r.u(2); // constrained_intra_pred_flag, transform_skip_enabled_flag
    if (r.u(1)) r.ue(); // cu_qp_delta_enabled_flag, diff_cu_qp_delta_depth
    pass(r, 'se', 'se'); // pps_cb_qp_offset, pps_cr_qp_offset
    r.u(1); // pps_slice_chroma_qp_offsets_present_flag
    pps.weightedPred = r.u(1);
    pps.weightedBipred = r.u(1);
    r.u(1); // transquant_bypass_enabled_flag
    const tiles = r.u(1);
    r.u(1); // entropy_coding_sync_enabled_flag
    if (tiles) {
        const columns = r.ue();
        const rows = r.ue();
        if (!r.u(1)) {
            for (let i = 0; i < columns + rows; i++) r.ue();
        }
        r.u(1); // loop_filter_across_tiles_enabled_flag
    }
    r.u(1); // pps_loop_filter_across_slices_enabled_flag
    if (r.u(1)) {
        // deblocking_filter_control_present_flag
        r.u(1); // deblocking_filter_override_enabled_flag
        if (!r.u(1)) pass(r, 'se', 'se'); // not disabled: beta, tc offsets
    }
    if (r.u(1)) hevcScalingListData(r);
    pps.listsModification = r.u(1);
    return pps;
}

function hevcWeights(r, refs, chroma) {
    const luma = [];
    const chromaFlags = [];
    for (let i = 0; i < refs; i++) luma.push(r.u(1));
    for (let i = 0; i < refs; i++) chromaFlags.push(chroma ? r.u(1) : 0);
    for (let i = 0; i < refs; i++) {
        if (luma[i]) pass(r, 'se', 'se');
        if (chromaFlags[i]) pass(r, 'se', 'se', 'se', 'se');
    }
}

function hevcSliceQp(nal, spss, ppss) {
    const type = (nal[0] >> 1) & 0x3f;
    if (nal[0] & 1 || nal[1] >> 3) return null; // nuh_layer_id > 0
    const r = new Bits(rbsp(nal, 2, SLICE_HEADER_BYTES));
    if (!r.u(1)) return null; // not the picture's first slice segment
    if (type >= 16 && type <= 23) r.u(1); // no_output_of_prior_pics_flag
    const pps = ppss.get(r.ue());
    if (!pps) return null;
    const sps = spss.get(pps.spsId);
    if (!sps) return null;
    r.skip(pps.extraSliceHeaderBits);
    const sliceType = r.ue(); // 0 B, 1 P, 2 I
    if (pps.outputFlagPresent) r.u(1);
    if (sps.separatePlanes) r.u(2);
    let temporalMvp = 0;
    let picTotalCurr = 0;
    if (type !== 19 && type !== 20) {
        // not IDR: the reference picture set
        r.skip(sps.pocLsbBits);
        let rps;
        if (!r.u(1)) {
            rps = hevcShortTermRps(r, sps.sets.length, sps.sets.length, sps.sets);
        } else {
            const at = sps.sets.length > 1 ? r.u(ceilLog2(sps.sets.length)) : 0;
            rps = sps.sets[at];
            if (!rps) return null;
        }
        for (const e of rps.s0) picTotalCurr += e.used;
        for (const e of rps.s1) picTotalCurr += e.used;
        if (sps.longTermPresent) {
            const fromSps = sps.longTermUsed.length > 0 ? r.ue() : 0;
            const count = fromSps + r.ue();
            for (let i = 0; i < count; i++) {
                if (i < fromSps) {
                    const at =
                        sps.longTermUsed.length > 1 ? r.u(ceilLog2(sps.longTermUsed.length)) : 0;
                    picTotalCurr += sps.longTermUsed[at] || 0;
                } else {
                    r.skip(sps.pocLsbBits);
                    picTotalCurr += r.u(1);
                }
                if (r.u(1)) r.ue(); // delta_poc_msb_present_flag, delta_poc_msb_cycle_lt
            }
        }
        if (sps.temporalMvp) temporalMvp = r.u(1);
    }
    if (sps.sao) {
        r.u(1); // slice_sao_luma_flag
        if (sps.chromaArrayType !== 0) r.u(1);
    }
    if (sliceType === 0 || sliceType === 1) {
        const isB = sliceType === 0;
        let refL0 = pps.refL0;
        let refL1 = pps.refL1;
        if (r.u(1)) {
            refL0 = r.ue() + 1;
            if (isB) refL1 = r.ue() + 1;
        }
        if (pps.listsModification && picTotalCurr > 1) {
            const bits = ceilLog2(picTotalCurr);
            if (r.u(1)) r.skip(bits * refL0);
            if (isB && r.u(1)) r.skip(bits * refL1);
        }
        if (isB) r.u(1); // mvd_l1_zero_flag
        if (pps.cabacInitPresent) r.u(1);
        if (temporalMvp) {
            const fromL0 = isB ? r.u(1) : 1;
            if ((fromL0 && refL0 > 1) || (!fromL0 && refL1 > 1)) r.ue();
        }
        if ((pps.weightedPred && !isB) || (pps.weightedBipred && isB)) {
            r.ue(); // luma_log2_weight_denom
            if (sps.chromaArrayType !== 0) r.se();
            hevcWeights(r, refL0, sps.chromaArrayType !== 0);
            if (isB) hevcWeights(r, refL1, sps.chromaArrayType !== 0);
        }
        r.ue(); // five_minus_max_num_merge_cand
    }
    return pps.initQp + r.se();
}

// ── The reader ───────────────────────────────────────────────────────────

/**
 * Reads the QP of each frame of one stream. The parameter sets are kept as
 * they come by (with each keyframe, before the decode path strips them), by
 * their id; a frame whose sets were never seen, or whose header this cannot
 * read, gives null.
 */
export class SliceQpReader {
    /** @param {'h264'|'hevc'} codec */
    constructor(codec) {
        this.codec = codec;
        this._sps = new Map();
        this._pps = new Map();
    }

    /**
     * The QP of the frame in an Annex B access unit, or null.
     * @param {Uint8Array} annexB
     * @returns {number|null}
     */
    read(annexB) {
        const hevc = this.codec === 'hevc';
        if (!hevc && this.codec !== 'h264') return null;
        let qp = null;
        const isSlice = hevc
            ? (head) => ((head >> 1) & 0x3f) < 32
            : (head) => (head & 0x1f) === H264_SLICE || (head & 0x1f) === H264_IDR;
        forEachNal(annexB, isSlice, (nal, slice) => {
            try {
                if (slice) {
                    qp = hevc
                        ? hevcSliceQp(nal, this._sps, this._pps)
                        : h264SliceQp(nal, this._sps, this._pps);
                } else if (hevc) {
                    const type = (nal[0] >> 1) & 0x3f;
                    if (type === HEVC_SPS) this._keep(this._sps, hevcSps(nal));
                    else if (type === HEVC_PPS) this._keep(this._pps, hevcPps(nal));
                } else {
                    const type = nal[0] & 0x1f;
                    if (type === H264_SPS) this._keep(this._sps, h264Sps(nal));
                    else if (type === H264_PPS) this._keep(this._pps, h264Pps(nal));
                }
            } catch (e) {
                // Unreadable: the frame gives null, a set is left out (the
                // next keyframe brings it again).
            }
        });
        return typeof qp === 'number' && qp >= 0 && qp <= 63 ? qp : null;
    }

    _keep(map, set) {
        if (map.size > 32) map.clear();
        map.set(set.id, set);
    }
}

/**
 * Calls `fn` with each NAL unit of an Annex B buffer (start code removed) up
 * to the frame's first slice, whose NAL is handed over to the buffer's end:
 * the scan stops there and leaves the slice data, nearly the whole buffer,
 * unread (the header reader takes SLICE_HEADER_BYTES of it at most).
 * @param {Uint8Array} b
 * @param {(head: number) => boolean} isSlice  by the NAL's first byte
 * @param {(nal: Uint8Array, slice: boolean) => void} fn
 */
function forEachNal(b, isSlice, fn) {
    let start = -1;
    for (let i = 0; i + 2 < b.length; i++) {
        if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue;
        if (start >= 0) {
            let end = i;
            while (end > start && b[end - 1] === 0) end--;
            if (end > start) fn(b.subarray(start, end), false);
        }
        start = i + 3;
        if (start < b.length && isSlice(b[start])) {
            fn(b.subarray(start), true);
            return;
        }
        i += 2;
    }
    if (start >= 0 && start < b.length) fn(b.subarray(start), false);
}
