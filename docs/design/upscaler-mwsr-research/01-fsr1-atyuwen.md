# FSR1 (EASU + RCAS) et l'optimisation mobile d'Atyuwen — résumé archivé (10/10/2026)

Résumé du rapport de recherche (le transcript complet n'a pas pu être archivé). Convention :
[M] mesuré par la source ; [C] affirmé sans donnée ; [I] inférence.

## Sources lues
- `raw.githubusercontent.com/GPUOpen-Effects/FidelityFX-FSR/master/ffx-fsr/ffx_fsr1.h` (v1.20210629, contenu v1.0.2), `ffx_a.h`, `readme.md`, `license.txt`, `docs/FidelityFX-FSR-Overview-Integration.pdf`, tags v1.0.1 / v1.0.2, `gpuopen.com/fidelityfx-superresolution/`.
- `atyuwen.github.io/posts/optimizing-fsr/` ; gist `78d6e810e6d0f7fd4aa6207d416f2eeb` (+ `/raw/opt_fsr.fxh`, `/raw/opt_fsr_easu.fxh`, API : 7 révisions, 30 commentaires) ; fork `atyuwen/FidelityFX-FSR`.
- Unity/AMD SIGGRAPH 2021 (`advances.realtimerendering.com/s2021/Unity AMD FSR - SIGGRAPH 2021.pdf`).
- Ports : Unreal « Mobile FSR » (doc Epic), Godot `fsr_upscale.glsl` + `thirdparty/amd-fsr`, Unity `FSRCommon.hlsl` + `ffx/ffx_fsr1.hlsl`, mpv `agyild/FSR.glsl`, RetroArch `edge-smoothing/fsr/*`, three.js `FSR1Node.js`, Looking Glass `ffx_fsr1_easu.frag` / `_rcas.frag`.
- `github.com/glebxxx/diablo1-4k/issues/9` (Vega 56) ; `SnapdragonStudios/snapdragon-gsr` (chiffres Adreno).

## Algorithme (en-tête AMD)
- EASU : `pp = ip*con0.xy + con0.zw`, 12 taps (bloc 4×4 moins les coins), 4 `textureGather` par canal aux positions `p0..p3` (constantes `con1..con3`), luma `0,5·B + (0,5·R + G)`, `FsrEasuSetF` appelée 4 fois (poids bilinéaires), direction normalisée (`zro` si `dirR < 1/32768`), `len` élevée au carré, étirement `stretch`, `len2`, `lob = 0,5 + ((1/4 − 0,04) − 0,5)·len`, `clp = 1/lob`, noyau `(25/16·(2/5·x² − 1)² − 9/16)·(1/4·x² − 1)²` en `d²` borné à `clp`, dering = clamp au min/max des 4 texels f, g, j, k. 36 registres en f32, cible ≤ 64 ; « VALU-bound » sur ordinateur.
- Variante f16 `FsrEasuH` : 2 taps par opération empaquetée, `FsrEasuSetH` 2 appels, `FsrEasuTapH` 6 appels, coordonnées et constantes en f32 ; « ABS is not free in the packed FP16 path » ; approximations `APrxLoRcp` (1 op), `APrxMedRcp` (3 ops), `APrxLoRsq` (2 ops).
- Constantes CPU `FsrEasuCon` : `con0 = (inVpX/outX, inVpY/outY, 0,5·inVpX/outX − 0,5, …)`, `con1 = (1/inSzX, 1/inSzY, +1/inSzX, −1/inSzY)`, `con2 = (−1/inSzX, +2/inSzY, +1/inSzX, +2/inSzY)`, `con3 = (0, +4/inSzY, 0, 0)` ; `FsrRcasCon` : `sharpness = exp2(−stops)`.
- RCAS : croix 5 taps (b, d, e, f, h), détection de bruit `nz`, `mn4/mx4` par canal, `hitMin/hitMax`, `lobe = max(−LIMIT, min(max3(lobeR,G,B), 0))·sharp`, `LIMIT = 0,25 − 1/16`, `rcpL = APrxMedRcp(4·lobe + 1)`, sortie `(lobe·(b+d+h+f) + e)·rcpL` ; v1.0.2 inclut le tap central dans la borne (« over-sharpen isolated pixels » corrigé) ; `FSR_RCAS_DENOISE` optionnel ; « do not use RCAS without EASU ».
- Entrée : RGB perceptuel [0,1], anti-aliasé, sans bruit ; « Negative input result in RCAS will output NaN » ; modes 1,3× / 1,5× / 1,7× / 2,0× ; « 1x to 4x area » ; rien de documenté au-delà de 2× par axe (le port mpv s'arrête à 2×) ; MIP bias `−log2(out/in)`.
- Annexes : SRTM (`c *= rcp(max3(c) + 1)`, tone-mapper réversible pour entrée HDR), LFGA, TEPD.

## Chiffres
| Appareil | Cas | Temps | Statut |
|---|---|---|---|
| iPhone 12 (A14), pixel shaders, 1772×819 → 2532×1170 | EASU f32 / RCAS | 5,4 / 0,9 ms | [M] Atyuwen |
| idem | f16 | 4,7 | [M] |
| idem | sans dering | 4,3 | [M] |
| idem | une analyse de direction | 3,8 | [M] |
| idem | sortie anticipée (`dirR < 1/64`, « valeur empirique ») | ≈ 3,6 (−0,2) | [M] |
| idem | 5 bilinéaires | 1,8 ; copie évitée 0,7 | [M] |
| PS4 Pro → 2160p | EASU f32 non optimisé / RCAS | 0,43 / 0,16 ms | [M] Unity SIGGRAPH 2021 |
| RX 6800 XT, RTX 3080 → 4K | FSR1 | « 0,40 ms ou moins » (1440p : 0,20) | [M] AMD, méthode non décrite |
| RX 6700 XT, RTX 3060 Ti | | 0,60 (0,30) | idem |
| RX 5700 XT, RTX 2060 S | | 1,0 (0,50) | idem |
| Vega 56 (Metal/SDL3), 1080p → 5K | EASU+RCAS f32 / MetalFX spatial | 2,4-3,1 / 1,8-2,9 ms | [M] auteur de l'issue |
| Snapdragon 888 / 8 Gen 1 / 8 Gen 2 (1240×576 → 1080p-1600p, fréquence max) | SGSR1 / bilinéaire | 0,476 / 0,248 ; 0,356 / 0,196 ; 0,295 / 0,156 ms | [M] Qualcomm |
| Radeon 780M (ROG Ally) | SGSR1 « plus rapide que FSR1 et Bicubic CAS », « 2 ms » | — | [C] forum |
| Unreal Mobile FSR | « 2× (f32) à 4× (f16) » | — | [C] Epic |

Aucun chiffre EASU/RCAS sur Adreno ni Mali dans une source primaire.

## Gist d'Atyuwen
- Révisions : 25/08/2021 (sans licence) → 27/08/2021 « Distributed under the MIT License » → 13/09/2021 « Copyright (c) 2021 atyuwen » → 04/04/2025 `opt_fsr.fxh` = `FsrMobile` (EASU + RCAS fusionnés).
- `FsrEasuL` : 5 échantillons bilinéaires RGB (croix), luma `0,5·R + G` (bleu retiré « to save some ALUs »), analyse unique, sortie anticipée `dirR < 1/64`, chemin contour 4 gathers × 3 canaux (f, g, j, k lus deux fois), 6 `FsrEasuTapH`, pas de dering, math en half, coordonnées en float ; dépend de l'en-tête AMD (MIT).
- `FsrMobile` : RCAS calculé sur l'anneau bilinéaire A/B/D/E (sans le centre, forme v1.0.1), pas de détection de bruit, facteur de netteté = `con0.x` (ratio de rendu), aucun paramètre.
- Précision : commentaires du gist : « Did you use fp16s on texcoord-related stuff? », `GL_EXT_shader_16bit_storage` absent en ES 3.10 → « convert half to mediump ».
- Licence du billet : CC BY-NC 4.0 (prose, figures) ; le code = le gist (MIT, texte complet absent).

## Ports (structure, licence)
- Godot 4 : compute 64 threads, `ARmp8x8`, 4 px/thread, `A_HALF` par défaut (`FsrEasuH/FsrRcasH`), repli f32 ; MIT + MIT AMD ; doc : « FSR1 is slower than Bilinear ».
- Unity : 2 passes, half sauf D3D11 (« known issues … math approximation functions on some DX11 drivers when FP16 is used ») ; SM 4.5 ; netteté 0..1 inversée.
- mpv (agyild) : 2 hooks luma, plafond 2×, options `FSR_EASU_DERING`, `FSR_EASU_SIMPLE_ANALYSIS`, `FSR_EASU_QUIT_EARLY`, `FSR_PQ` ; f32 ; MIT AMD.
- RetroArch : 2 passes, « no textureGather, direct texelFetch of 12 unique texels » ; `.slang` Unlicense + en-tête AMD MIT.
- three.js `FSR1Node` (WebGPU/TSL, 2026) : 2 passes HalfFloat, 12 `textureLoad`, « can't make use of packed math (e.g. FP16) » ; MIT.
- Looking Glass : GLSL ES 3.00 `highp`, `FSR_EASU_F` avec `textureGather`, `FSR_RCAS_DENOISE 1` ; GPLv2 (client), shaders AMD MIT ; n'a pas adopté la version d'Atyuwen.

## Licences
MIT AMD (+ avis Michal Drobot dans `ffx_a.h`) : conserver les avis ; AMD demande les noms « AMD FidelityFX Super Resolution 1.0 » / « AMD FSR 1.0 » et de ne pas exposer « RCAS ». Gist : MIT + copyright atyuwen + avis AMD. Billet : CC BY-NC 4.0. Unity : non vérifiée. RetroArch : Unlicense déclaré, dépôt sans licence globale.

## Non vérifié
Mesures EASU/RCAS sur Adreno ou Mali ; code source d'Unreal « Mobile FSR » ; méthode de mesure d'Atyuwen ; comportement au-delà de 2× ; comptes ALU par passe ; sens du facteur `con0.x` dans `FsrMobile` ; FSR dans libplacebo, Magpie, Lossless Scaling ; licence du package Unity ; mention du gist dans la liste IP de Mario Kart World.
