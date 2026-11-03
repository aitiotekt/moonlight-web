# SGSR1 (Snapdragon Game Super Resolution v1) — résumé archivé (10/10/2026)

Résumé du rapport de recherche (le transcript complet n'a pas pu être archivé). Convention :
[M] mesuré par la source ; [C] affirmé sans donnée ; [code] lu dans le source.

## Sources lues
- `github.com/SnapdragonStudios/snapdragon-gsr` : README, LICENSE, CONTRIBUTING, `sgsr/v1/README.md`, `sgsr/v2/README.md`, `sgsr/v1/include/glsl/sgsr1_shader_mobile.frag` (142 lignes, version « originale » restaurée le 16/10/2025 par `d926f074`), `sgsr1_shader_mobile_edge_direction.frag`, `hlsl/sgsr1_mobile.h`, `sgsr1_shader_mobile.hlsl`, issues 1-4 et 8, historique (aucun commit entre 08/2023 et 10/2024 : la « 1.1.0 » du README ne correspond à rien).
- Plugins : `SnapdragonStudios/snapdragon-game-plugins-for-unreal-engine` (`sgsr.ush`, `PostProcessSGSR.usf`), `SnapdragonGameStudios/com.qualcomm.snapdragon.sgsr.for.unity` (v1.0.0, 2026-07-28), framework Vulkan Adreno (`samples/sgsr`).
- Qualcomm : onq 26/04/2023 « Introducing Snapdragon Game Super Resolution » ; dev blog 10/06/2024 « Up your game with Snapdragon Gaming Super Resolution » (figures 1 et 2) ; blog VR 26/04/2023.
- Tiers : Arm ASR (via presse : smartworld.it, PCGamesN), Mob-FGSR (SIGGRAPH 2024), RenderSR (CVPR-W 2022), `Tyuwwe/SR_Compare`, Unity Discussions, forum Lossless Scaling, `gnu.org/licenses/license-list.en.html`.

## Algorithme [code]
- `precision mediump float; precision highp int;` ; sampler `mediump` ; coordonnées `highp` ; `ViewportInfo = (1/inW, 1/inH, inW, inH)` de la texture d'entrée (non documenté, issue #3).
- Mode 1 (RGBA) : `color = textureLod(ps0, uv, 0)` (un bilinéaire) ; `imgCoord = uv·inSize + (−0,5, +0,5)` ; `left = textureGather(ps0, coord, 1)` (canal vert) ; `edgeVote = |left.z − left.y| + |G − left.y| + |G − left.z|` ; si `edgeVote ≤ 8/255` → sortie bilinéaire.
- Sinon : 3 gathers de plus (`right`, `upDown`), 12 taps = bloc 4×4 moins les coins ; `mean` des 4 centraux ; `sum = Σ|c_i|` ; `std = 2,181818/sum` (GLSL principal) **ou** `(10,14185/sum)²` (HLSL, variante edge-direction) ; `x = (dx² + dy²)·0,55 + clamp(|c|·std, 0, 1)` (HLSL : 0,5) ; `fastLanczos2(x) = (x − 1)(x − 4)³` ; `finalY = Σ(w·c)/Σw` ; `finalY = clamp(2,0·finalY, minY, maxY)` (2×2 central) ; `deltaY = clamp(finalY − color.w, −23/255, +23/255)` (GLSL seulement) ; `rgb = clamp(rgb + deltaY, 0, 1)`. Chroma = bilinéaire.
- Variante `UseEdgeDirection` : `edgeDirection(left, right)` (deux différences diagonales normalisées), `edgeDis = dx·dir.y + dy·dir.x`, `x = r² + edgeDis²·(0,7·clamp(c²·std, 0, 1) − 1)` ; « adds a small additional cost … might lower wave occupancy ».
- `OperationMode` : 1 RGBA (luma = vert), 3 RGBY (alpha = luma écrite par l'application), 4 LERP (bilinéaire pur). Plugins : chemin HIGH_QUALITY (luma Rec. 601, 12 gathers + 1 bilinéaire, deux noyaux mélangés 0,6/0,4, seuil 4/255) — toujours une seule passe de rendu.
- Défauts : `EdgeThreshold` 8/255 (4/255 VR), `EdgeSharpness` 2,0 (plage [1, 2]), alpha forcé à 1.
- Contraintes : entrée « tonemapped and anti-aliased », ≤ 2× par axe, UI 2D à rendre en natif ; rien sur gamma vs linéaire, rien sur la réduction ni le HDR ; `#version 300 es` avec `textureGather` (ES 3.10 seulement : pas WebGL2).
- Écarts du port du dépôt MoonlightWeb : seuil 6/255, netteté 1,5, pas de clamp ±23/255.

## Chiffres
| Source | Appareil | Cas | Temps | Statut |
|---|---|---|---|---|
| README v1 | Snapdragon 888 / 8 Gen 1 / 8 Gen 2, fréquence GPU max, entrée 1240×576 → 2340×1080 / 2400×1600 | SGSR1 (seuil 4 / 8) | 0,4756 / 0,4754 ; 0,3563 / 0,3543 ; 0,2952 / 0,2939 ms | [M] méthode non décrite |
| idem | idem | bilinéaire (LERP) | 0,2476 ; 0,1963 ; 0,1558 ms | [M] |
| blog 2024, fig. 2 | 8 Gen 2 | SGSR1 vs « Competitor Upscaling », entrées 1240×576 / 1552×720 / 1864×846 | ≈ 0,30-0,32 vs ≈ 0,62-0,63 ms | [M] concurrent non nommé |
| onq 2023 | — | « two times performance improvement compared to other mobile upscaling solutions » | — | [C] |
| README v2 | 8 Gen 3, sortie 1260×2800 | SGSR2 2-pass fragment / 2-pass compute / 3-pass compute à 2,0× | 0,905 / 1,801 / 2,015 ms | [M] |
| Arm (concurrent), via presse | Immortalis-G720 | gain d'images par seconde : ASR +53 %, GSR +47 %, FSR 2 +40 % | — | [C] |
| Lossless Scaling, forum | RTX 3080 Ti | usage GPU SGSR / FSR / LS1 | 75 / 77 / 80 % | anecdotique |

Aucune mesure indépendante (ms, mW, PSNR) de SGSR1 sur aucun GPU ; aucune mesure d'énergie d'un upscaler mobile ; « 15 texture instructions » de Qualcomm ≠ 5 dans le source.

## SGSR2
Temporel : `InputColor`, `InputDepth`, `InputVelocity`, jitter de caméra, matrices, historique ; 2 ou 3 passes. Inapplicable à un client qui ne reçoit que des images décodées.

## Licence
BSD-3-Clause, © 2023 (GLSL : 2025) Qualcomm Innovation Center ; FSF : compatible GPL ; GPLv3 §7 b et d couvrent les clauses 1-3. Obligations : notice + conditions + disclaimer dans le fichier dérivé et dans les notices binaires ; pas de promotion avec « Qualcomm » ni « Snapdragon™ » ; « SGSR1 » dans un menu = usage descriptif. Pas de concession de brevet expresse (comme MIT). Plugins Unreal : BSD-3 + licences AMD (RCAS).

## Non vérifié
Page Qualcomm « Adreno GPU on Mobile: Best Practices » (texte obtenu par le rapport WebGPU, pas par celui-ci) ; billet Arm ASR original (404) ; thèse Uppsala sur l'énergie ; figure 3 de l'article onq 2023 ; contenu de la « 1.1.0 » ; issue #8 ; appartenance de `textureGather` à ES 3.00 (non : ES 3.10) ; toute mesure indépendante.
