# Upscaler `mwsr` — rapport de la phase P3 (HDR, 4:4:4, réduction)

Phase P3 du plan `upscaler-mwsr.md` (§4, §8.1 critères C8, C9, C10, §8.2 tests dorés), jouée le
21/10/2026 au go de Bruno, Fable 5.1 `max`. Journal des essais : `scripts/bench/scaler-lab/journal.md`
J11 à J14. Toutes les mesures de qualité sont de SwiftShader (le texte y rend les pixels du RTX au
centième : contrôle SDR à ×2 identique à P2) ; les temps GPU sont du RTX 5060 Ti et du Radeon 780M
(§6).

## 1. Ce que P3 construit

**Le texte** (`frontend/js/stream/renderers/MwsrShader.js`) a maintenant deux modes, choisis par image
par `mwsrRegime(inW, inH, outW, outH, { srgb })` : `copy` à 1:1 exact (le renderer copie, P1), `up` (le
noyau de P2, inchangé), `down` (la réduction : grille k×k d'échantillons bilinéaires sur l'empreinte du
pixel, moyennée en lumière linéaire). Deux tables donnent la grille, son étendue et la lumière
(`linearLight`) par échelle : `MWSR_DOWN_TAPS_SRGB` quand le renderer lit et écrit à travers des vues
`-srgb` (un seul échantillon jusqu'à ×0,5, puis 3×3 et 4×4, `LINEAR_LIGHT 0` : le matériel fait la
lumière), `MWSR_DOWN_TAPS` sinon (2×2 d'abord, `LINEAR_LIGHT 1`).
Nouveaux `override` : `CHROMA444` (vote, cohérence et poids par canal, pour les flux 4:4:4), `R_DOWN`
(étendue de la grille), `LINEAR_LIGHT` (0 encodé, 1 gamma 2, 2 sRGB exact). `mwsrWgsl({feed, half,
mode, taps})` génère les textes (grilles de 1, 4, 9 ou 16 échantillons) ; la réduction est déroulée
(aucune boucle), `half` ne s'applique qu'au chemin contour du mode `up`. Dix tests `vitest`.

**Le labo** : le feed HDR (`hdr=1` : textures et cibles `rgba16float`, image en demi-flottants
`f16:<url>`, dépôts `.f16`), les mires HDR (`hdr_mires.py`) et leurs métriques en lumière linéaire
(`metrics_hdr.py` : ΔE ITP, PSNR/SSIM en PQ, maximum, dépassement en nits), la mire `codeiso`
(couleurs isoluminantes), la simulation 4:2:0, la référence Lanczos-2 en lumière linéaire, la cellule
`smooth2d` (Canvas2D `high`), les vues sRGB (`viewFormats` sur l'entrée et la sortie SDR, cellules
`tex-s1-srgb` et `mwsr:srgb=1`), les métriques de chroma (PSNR Cb/Cr, ΔE00) et de zone-plate (énergie
d'aliasing, moiré, traits fins), les flux `--hdr-quality`, `--c444-quality`, `--reduce-quality`, le jeu
de temps `--p3`, et les empreintes dorées `--golden` / `--golden-check` (`p3_flows.py`).

## 2. HDR (C8)

**Ce que le feed est vraiment.** Le plan (§4.1) attendait de la lumière de scène et prévoyait une
compression réversible `y = x / (x + k)` autour du noyau. La passe 0 HDR du renderer écrit des valeurs
**encodées sRGB prolongées au-delà de 1,0** (203 nits = 1,0, 1000 nits ≈ 2,0, 10000 nits ≈ 5,3) : la
dynamique est déjà compressée par la courbe de transfert, les seuils du noyau (τ, netteté) y sont
comparables à ceux du SDR, et le noyau, borné par ses échantillons et sans écrêtage à 1,0, tourne tel
quel. **La compression du plan est sans objet ; aucun changement de texte pour le HDR.**

**Mesure** (J11, trois mires, 720p → 1440p). ΔE ITP moyen de `mwsr` contre FSR1 `linear`, l'enhancer HDR
du produit : texte 15,4 contre 16,7, jeu 3,54 contre 3,64, rampe 31,3 contre 30,7 (mais 23,6 contre 25,9
au centre) ; p99 ≤ FSR1 sur texte et jeu ; PSNR PQ 22,8 / 39,1 / 17,7 contre 22,5 / 37,9 / 17,9. Le
maximum est conservé (le max local de l'entrée, jamais au-delà : **0 % de dépassement** sur les trois
mires, contre 4,8 à 5,2 % pour FSR1, dont RCAS pousse les reflets 10 % au-dessus de l'entrée). SGSR1
écrête à 1,0 sur ses contours (ΔE 34 sur le texte) : inutilisable en HDR, comme le produit le sait.

**Verdict C8 (qualité) : tenu** — ΔE borné au niveau de FSR1 (−3 à −8 % sur deux mires, +2 % sur la
rampe), maximum conservé, aucun pixel au-delà du maximum local. Le temps ajouté par le shader sur le
feed `rgba16float` (« ≤ FSR1 `linear` ») est au §6 ; le regard de Bruno sur le M27Q reste pour P5.

## 3. 4:4:4 (C9)

Mires `code` (syntaxe colorée sur fond sombre) et `codeiso` (mêmes couleurs à luma égale : chaque
contour n'est qu'un contour de chroma), en 4:4:4 et à travers un pipeline 4:2:0 simulé (J13).

- Sur la **syntaxe ordinaire**, la luma voit déjà chaque contour : `CHROMA444` ne change pas les pixels
  (14,4 → 16,0 % de quads). Le défaut égale FSR1 en ΔE00 (1,614 contre 1,626 en 4:4:4 ; 1,742 contre
  1,743 en 4:2:0), reste 0,1 à 0,4 dB sous lui en PSNR de chroma, et est le seul sans dépassement (FSR1
  1,2 %, SGSR1 4,9 %).
- Sur les **bords isoluminants**, le cas pour lequel le mode existe, la luma seule ne voit rien
  (`mwsr` = bilinéaire = SGSR1 = FLIP 0,014) ; `CHROMA444` les voit (11,7 % de quads) : FLIP 0,011,
  ΔE00 −10 %, SSIM 0,9751 → 0,9785 ; FSR1 fait un cheveu mieux (ΔE00 0,654 contre 0,675) parce que son
  rééchantillonnage affûte tous les canaux par construction, au prix de 1,2 % de dépassements. Aucun
  réglage de `c444` (netteté, τ, poids) ne déplace ces chiffres.
- `LUMA_SHARP` (netteté par la luma seule, teinte conservée), essayé pour les franges 4:2:0 et le HDR :
  −0,03 de ΔE00 sur la chroma, perdant en luma SDR et en HDR. **Retiré du texte.**

**Verdict C9 : mieux que SGSR1 partout ; égal à FSR1 en ΔE00 sur la syntaxe, 3 % derrière lui sur les
bords isoluminants.** La première moitié du critère est tenue, la seconde à 3 % près. `CHROMA444` reste,
pour les flux 4:4:4 que `StreamView` connaît (`_yuv444`, P4) ; son coût à 1 est au §6, nul à 0.

## 4. Réduction (C10)

Le mode `down` contre la référence du critère (Lanczos-2 de l'hôte en lumière linéaire), le Smooth2D de
Canvas2D, le bilinéaire du client WebGPU, et FSR1 et SGSR1 hors domaine, tels que le client les fait
tourner aujourd'hui sur un flux plus grand que l'écran (J12).

- **La lumière linéaire est le terme décisif** : +2,5 dB (×0,75) à +6 dB (×0,5) sur le texte, +12 dB à
  ×0,33 contre le bilinéaire ; FLIP divisé par trois à cinq. La moyenne en valeurs encodées assombrit
  toute structure fine. Le sRGB exact gagne ≤ 0,35 dB sur le gamma 2 et le perd en FLIP sur le texte
  ×0,5 : **`LINEAR_LIGHT 1` (carré, racine) par défaut**, 2 en option sur les GPU où quinze `pow` sont
  gratuits (§6).
- **Grilles en lumière logicielle** (`LINEAR_LIGHT 1`, J12) : 0,5 ≤ s < 1 → 2×2 à l'étendue 1 (la boîte
  exacte à ×0,5 ; FLIP 0,015 contre 0,054 pour la 3×3 sur le texte) ; 0,25 ≤ s < 0,5 → 3×3 à l'étendue
  1,25 (+2,7 dB sur le texte, moiré −40 %, FLIP égal) ; s < 0,25 → 4×4 à 1,25 (régime du plan, non
  mesuré). C'est la table `MWSR_DOWN_TAPS`, celle des feeds sans vue sRGB (le `rgba16float` du HDR).
- **Les vues sRGB font mieux, gratuitement (J15).** Lue et écrite à travers des vues `-srgb`, la
  réduction fait décoder chaque texel par l'échantillonneur *avant* le filtrage et encoder par la cible
  à l'écriture : sRGB exact, sans une instruction. Ce n'est pas décoder après l'échantillon bilinéaire
  (`ll=2`) : dès que les échantillons tombent entre les texels, le mélange en gamma à l'intérieur de
  chacun biaise la moyenne (zone-plate ×0,33 : 23,7 dB contre 30,0, aliasing 0,056 contre 0,013). Entre
  ×0,5 et 1:1, **un seul échantillon bilinéaire à travers les vues** bat toutes les grilles en PSNR
  (×0,75 : texte 30,18 contre 27,2-28,9, zone 22,57 contre 20,4-22,0), divise le FLIP du plancher par
  deux et son aliasing par 2,2, et à ×0,5 c'est la boîte exacte, pixel pour pixel ; **son coût est celui
  du plancher** (l'échantillon que le client fait déjà). Sous ×0,5, la 3×3 à travers les vues : +7,4 dB,
  aliasing ÷ 5 et FLIP ÷ 11 sur la zone-plate contre la même grille en lumière logicielle (texte :
  −2,8 dB de PSNR, FLIP meilleur). Table `MWSR_DOWN_TAPS_SRGB` : 0,5 ≤ s < 1 → 1 échantillon ;
  0,25 ≤ s < 0,5 → 3×3 à 1,25 ; s < 0,25 → 4×4 à 1,25 ; `LINEAR_LIGHT 0`.
- Contre le critère, à travers les vues : énergie d'aliasing ≤ Smooth2D partout (×0,75 : 0,074 contre
  0,165 ; ×0,33 : 0,013 contre 0,148) ; PSNR contre le Lanczos-2 de l'hôte sur le texte 30,2 (×0,75),
  30,8 (×0,5), 32,2 (×0,33) — bilinéaire 19,5 à 26,0, Smooth2D 26,0. FSR1 et SGSR1 en réduction font
  pire que le bilinéaire (FSR1 : 27 à 50 % de dépassements à ×0,33).

**Verdict C10 (qualité) : tenu** avec marge, et en coût par les vues sRGB (§6).

## 5. Tests dorés (plan §8.2)

`scaler_lab.py --golden --swiftshader` rend, sur l'adaptateur logiciel, `tex-s1`, `mwsr`,
`mwsr:dering=0` et `mwsr:c444=1` sur `text`, `game` et `code` à ×2 et ×1,33, et `tex-s1`, `mwsr`,
`mwsr:taps=9` et `mwsr:ll=2` sur `text`, `zone` et `code` à ×0,5 ; pour chaque sortie une empreinte des
pixels (SHA-256), la moyenne et le PSNR contre le bilinéaire du même tour, dans
`scripts/bench/scaler-lab/golden.json`. `--golden-check` recommence et sort en erreur à la première
empreinte changée, en disant de combien la moyenne et le PSNR ont bougé. Les empreintes dépendent des
polices de la machine (les mires sont dessinées par la page) : celles du dépôt sont de DualRTX ; le job
CI (P4, non bloquant d'abord) les régénérera une fois sur sa machine. Le jeu : `tex-s1`, `mwsr`,
`mwsr:dering=0`, `mwsr:c444=1` à ×2 et ×1,33 ; `tex-s1`, `mwsr`, `mwsr:srgb=1`, `mwsr:taps=9`,
`mwsr:ll=2` à ×0,5.

## 6. Temps GPU (J14) et le coût de la réduction

Passes du 21/10 sur DualRTX (créneau de 59 ; Chrome sans tête épinglé par `--use-adapter-luid`,
adaptateur vérifié par une sonde avant chaque passe) : RTX 5060 Ti et Radeon 780M, GPU p50 en ms,
trois tours.

**C8, le feed HDR** (textures et cible `rgba16float`, mire texte HDR, ×2 et ×1,33 vers 1440p) :

| cellule | 780M ×2 | 780M ×1,33 | RTX ×2 | RTX ×1,33 |
|---|---|---|---|---|
| plancher (`tex-s1`, cible f16) | 0,642 | 0,860 | 0,056 | 0,056 |
| FSR1 | 9,51 | 9,57 | 0,247 | 0,250 |
| SGSR1 | 2,502 | 2,404 | 0,069 | 0,066 |
| **`mwsr`** | **1,517** | **1,390** | **0,058** | **0,057** |
| `mwsr:half=1` | 1,387 | 1,292 | 0,058 | 0,057 |

`mwsr` vaut 0,16 × FSR1 sur le 780M et 0,23 × sur le RTX. La cible f16 coûte +0,26 ms à tous sur le
780M (plancher 0,385 → 0,642) et le noyau y ajoute ses ≈ 0,9 ms de SDR ; sur le RTX l'écriture f16
cache le noyau (+2 % sur le plancher). `half` : −9 % sur le 780M, et sur le RTX les mêmes pixels que le
f32 (ΔE ITP au millième, même maximum en nits) jusqu'à 10 000 nits : le module f16 est sûr sur le feed
HDR. **C8 temps : tenu.** Il reste à C8 le regard de Bruno sur le M27Q (P5).

**`c444=1`** : +7 % (780M, 0,899 → 0,964) et +8 % (RTX, 0,039 → 0,042) sur la mire `code` à ×2 ; à 0 le
chemin n'existe pas (constante de pipeline).

**C10, le coût de la réduction** (`text` ×0,75 et ×0,5, `zone` ×0,33 ; `mwsr` = la table logicielle de
J12) :

| cellule | 780M ×0,75 | 780M ×0,5 | 780M ×0,33 | RTX ×0,75 | RTX ×0,5 | RTX ×0,33 |
|---|---|---|---|---|---|---|
| plancher (`tex-s1`) | 0,246 | 0,145 | 0,336 | 0,016 | 0,007 | 0,016 |
| FSR1 | 5,284 | 2,364 | | 0,136 | 0,062 | |
| SGSR1 | 1,284 | | | 0,039 | | |
| `mwsr` (2×2, 2×2, 3×3 ; `ll=1`) | 0,541 | 0,246 | 1,059 | 0,022 | 0,009 | 0,026 |
| `mwsr:ll=2` (sRGB calculé) | 1,585 | 0,709 | 1,426 | 0,048 | 0,021 | 0,040 |
| `mwsr:taps=9` | 1,174 | 0,559 | (table) | 0,048 | 0,022 | (table) |
| `mwsr:taps=16` | | 0,920 | 1,692 | | 0,037 | 0,039 |
| `mwsr` / plancher | 2,20 | 1,69 | 3,15 | 1,40 | 1,30 | 1,66 |

La grille en lumière logicielle **manque** le critère « ≤ bilinéaire + 30 % » : 2,2 × le plancher à
×0,75 et 1,7 × à ×0,5 sur le 780M (1,4 × et 1,3 × sur le RTX), 3,2 × à ×0,33 (1,7 ×) ; en absolu 0,54 ms
pour une sortie 1080p sur le 780M, 3 % d'une image à 60 Hz. Le plancher est un échantillon ; la grille
en fait k² et y ajoute le décodage et l'encodage, qui pèsent autant que les échantillons sur le 780M
(`ll=2` ×2,9 ; le 4×4 ×3,7 pour rien). Contre ce que le client fait aujourd'hui en réduction avec un
enhancer allumé : FSR1 5,28 ms (×10) et SGSR1 1,28 (×2,4), tous deux pires que le bilinéaire.

**La réponse est au §4 : les vues sRGB (J15).** Entre ×0,5 et 1:1 le filtre devient l'unique
échantillon bilinéaire que le client fait déjà, à travers des vues `-srgb` : coût = plancher, **C10
tenu en coût (+0 %) et en qualité** sur tout le domaine du critère (×0,75 et ×0,5). Confirmé au GPU
(passe de 14:33, cellules `tex-s1-srgb` et `mwsr:srgb=1` du jeu `--p3`) : les vues ne coûtent rien
(`tex-s1-srgb` = `tex-s1`, 780M 0,241 ms = 0,241 à ×0,75, RTX 0,016 = 0,016) et l'échantillon unique
vaut le plancher (780M 0,250 à ×0,75, 0,146 = 0,146 à ×0,5 ; RTX 0,016 et 0,007, égaux) ; la 2×2 à
travers les vues coûte sa grille calculée (0,539 = 0,539, comme `ll=0` : sur le 780M aussi ce sont les
échantillons qui coûtent, seul le `pow` de `ll=2` pèse). Sous ×0,5 la 3×3 à travers les vues coûte sa
grille calculée (780M 1,041 contre 1,058 ; RTX 0,026), 3,1 × le plancher ; celui-ci y étant un
échantillon ponctuel inutilisable (9,8 dB sur la zone-plate), la référence de coût est Smooth2D, que le
navigateur paie sur le CPU. `LINEAR_LIGHT 2` sort des défauts partout (×2,9 sur le 780M, ×2,2 sur le
RTX) et reste une option ; `LINEAR_LIGHT 1` reste le défaut de la table logicielle.

**Sur le téléphone du critère** (realme Note 60, Mali-G57 MP1, journal J16, 21/10) : à ×0,67 (1080p →
1600×720, l'écran du realme) le plancher fait 1,31 ms (1,18 à travers les vues sRGB), l'échantillon
unique à travers les vues **1,18**, la grille 2×2 3,80 (vues ou pas : sur Mali ce sont les échantillons
qui coûtent), FSR1 26,0 ; à ×0,5, 1,05 / 0,92 / **0,98** / 3,08, `ll=2` 8,06. **C10 tenu en coût sur sa
machine**, par les vues.

## 7. Ce que P3 laisse

- **Au renderer (P4)** : `viewFormats: ['rgba8unorm-srgb']` sur la texture de la passe 0 et
  `viewFormats: [format + '-srgb']` dans la configuration du canvas SDR (à l'essai ; repli sur la table
  logicielle si le navigateur refuse) ; en mode `down`, lier la vue sRGB de l'entrée et dessiner dans
  la vue sRGB du canvas (`getCurrentTexture().createView({ format })`), `mwsrRegime(…, { srgb: true })`
  donnant `taps`, `R_DOWN` et `LINEAR_LIGHT` ; en `up` et à 1:1 les vues ordinaires (le noyau travaille
  en gamma, à dessein). `CHROMA444 1` quand `StreamView._yuv444` l'annonce. Le module `half` quand
  `shader-f16` est là, hors NVIDIA, HDR compris.
- **À mesurer** : sur le realme (fait le 21/10, J16 : C1 tenue, `half` −10 %, `DERING 0` −27 %,
  réduction au coût du plancher par les vues) il reste `ext-mwsr` (l'externe y est RGBA : la passe 0
  pourrait s'y éviter) ; le 4×4 sous ×0,25.
- **Au regard de Bruno (P5)** : le HDR sur le M27Q (C8) ; l'A/B de la réduction sur le téléphone.
- **Hors v0.4.1** : l'étude temporelle (plan §14, P7) ; le noyau `up` en lumière linéaire (non voulu :
  le vote et la netteté sont perceptifs ; la cellule `mwsr:srgb=1` à ×2 existe au labo si un jour il
  faut le vérifier).

