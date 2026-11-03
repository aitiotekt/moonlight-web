# Upscaler `mwsr` — rapport de la phase P1 (contournement 1:1)

> Phase P1 du plan `upscaler-mwsr.md` (§5, §9, critère C7 du §8.1). Code le 20/10/2026
> (`36edf6ec`), labo joué le 20/10 après-midi sur DualRTX, SwiftShader puis RTX 5060 Ti, au
> créneau donné par la session d'orchestration ; mesure plein écran clic → photon le 21/10 au
> matin, au créneau de Bruno (§6). Reste la décision « blit ou deux canvas » (§6).

## 1. Ce que P1 a changé dans le client

- **Détection par image.** `WebGpuRenderer` et `WebGlRenderer` comparent à chaque `draw()` la
  taille de l'image à celle du canvas, par la règle de taille qu'ils partageaient par copie et qui
  vit désormais dans `scaleRegime.js` (`fitOutputSize`, `isIdentityScale`) : l'identité est
  l'égalité exacte sur les deux axes. Une boîte plus large ou plus haute d'un pixel reste 1:1,
  l'image garde sa taille ; un pixel de plus sur les deux axes est un rééchantillonnage.
- **Copie directe.** À 1:1 l'image passe par la passe `off` existante, quel que soit l'enhancer
  choisi : une passe, pas de texture intermédiaire, une seule écriture du canvas. L'enhancer
  reprend à l'image suivante dont la taille diffère, sans rien recréer. En HDR la passe 0
  (lecture YUV ou tone-map) existe dans ses deux cibles dès la création : plus aucune
  reconstruction de pipeline au changement de régime ni de cran.
- **`passthrough`.** Le renderer dit s'il a copié la dernière image. Le gouverneur le reçoit dans
  son observation et tient (ni descente ni remontée sur une fenêtre de copies, minuteries remises
  à zéro à la reprise) ; l'overlay des stats affiche « Off (1:1) » (en, fr, zh) au lieu du nom
  d'une passe qui ne tourne pas. Le worker le poste avec ses compteurs toutes les 500 ms ; le
  chemin thread principal le lit directement.
- **Tests** : `scaleRegime.test.js` (ajustement, plafond 4096, 1:1 exact contre presque-1:1),
  `EnhancerGovernor.test.js` (fenêtres de copies, horloge remise). Suite complète verte
  (151 fichiers, 1588 tests).

## 2. L'instrument

Le labo de P0 (`scripts/bench/scaler-lab/`), avec ce que `875c956a` lui a ajouté :

- les cellules `chain-*` (le `WebGpuRenderer` du produit sur un `OffscreenCanvas`, une image par
  tampon de commandes) honorent `pace=tick` (un `draw()` toutes les 16,7 ms, le régime d'un flux à
  60 i/s) et `flip=1` (la taille de sortie alterne à chaque draw entre celle de la page et celle de
  l'image : le passage 1:1 ↔ échelle dans les deux sens, à chaque image) ;
- par draw : le nombre de passes (crochets sur `beginRenderPass`), si le renderer a copié
  (`renderer.passthrough`), et le temps GPU total par nombre de passes ;
- `--p1` joue trois cas sur l'image `text` : `x1-chain` (1440p → 1440p : `blit`, `tex-s1`,
  `blit+sgsr-repo`, `blit+nis`, `blit+fsr1` — ce que les mêmes passes coûtaient à l'échelle 1 avant
  P1 — puis `chain-off`, `chain-sgsr`, `chain-nis`, `chain-fsr1`), `x1-chain-tick` (les quatre
  chaînes à 60 i/s) et `x2-flip` (720p → 1440p, les quatre chaînes en bascule) ; deux tours
  entrelacés, 8 lots de 16 draws par tour.

Le passage SwiftShader a révélé un défaut du pilote : le `+` des cellules `blit+*` était décodé en
espace par `URLSearchParams`, les trois cellules ne tournaient pas (« error: cell blit sgsr-repo? »).
Corrigé (`%2B` dans la liste P1) avant le RTX.

**Limite** : le labo horodate WebGPU seulement. Le jumeau WebGL2 partage la détection
(`scaleRegime.js`, testé) mais son chemin de dessin n'est pas mesuré ici ; il le sera à la mesure
plein écran, dont « blit WebGL2 » est l'un des trois présentateurs.

## 3. SwiftShader (validation, un tour)

Règle « WARP d'abord » : le code neuf tourne sur l'adaptateur logiciel avant tout GPU. Temps GPU
p50 en ms, 32 draws par cellule.

| Cas | `chain-off` | `chain-sgsr` | `chain-nis` | `chain-fsr1` |
|---|---|---|---|---|
| `x1-chain` (1440p, lot) | 69,8 · 1 passe | 68,2 · 1 passe · copies 32/32 | 68,6 · 1 passe · 32/32 | 68,0 · 1 passe · 32/32 |
| `x1-chain-tick` (1440p, 60 i/s) | 69,6 · 1 passe | 68,2 · 32/32 | 67,5 · 32/32 | 67,6 · 32/32 |
| `x2-flip` (720p ↔ 1440p) | 39,7 · 1 passe | 1 passe 16,4 (16 copies) / 2 passes 52,3 (16) | 16,4 (16) / 566,9 (16) | 16,1 (16) / 92,7 (16) |

Sur SwiftShader la lecture de la texture externe domine tout (`blit` 69,9 ms contre `tex-s1`
5,8 : la conversion NV12 → RGB se fait en logiciel à chaque lecture) ; les absolus ne disent rien
d'un GPU. Ce qui compte : à 1:1 les trois chaînes font **une passe**, **toutes leurs images sont
des copies**, au coût de `off` ; en bascule, les passes alternent strictement (16 et 16), sans
erreur, 32 draws sur 32.

## 4. RTX 5060 Ti

Chrome 155 sans tête, `--enable-webgpu-developer-features`, profil jetable, 127.0.0.1 seulement,
aucun écran branché sur ce GPU ; dispersion tour à tour ≤ 4,2 %. Temps GPU en ms, 64 draws par
cellule `chain-*`.

**`x1-chain` — 2560×1440 → 2560×1440, texte, en lot**

| Cellule | passes | GPU p50 | p90 | p99 | disp. % | mur / draw | par passe |
|---|---|---|---|---|---|---|---|
| `blit` (passe 0 seule) | 1 | 0,030 | 0,032 | 0,034 | 0,2 | 0,198 | 0,030 |
| `tex-s1` (le plancher) | 1 | 0,028 | 0,028 | 0,031 | 0,8 | 0,230 | 0,028 |
| `blit+sgsr-repo` (avant P1, à l'échelle 1) | 2 | 0,109 | 0,110 | 0,274 | 1,3 | 0,210 | 0,039 / 0,070 |
| `blit+nis` (avant P1) | 2 | 0,380 | 0,384 | 0,549 | 1,1 | 0,550 | 0,039 / 0,340 |
| `blit+fsr1` (avant P1) | 3 | 0,289 | 0,293 | 0,454 | 1,3 | 0,425 | 0,042 / 0,188 / 0,058 |
| `chain-off` | 1 | 0,032 | 0,032 | 0,035 | 1,3 | 3,980 | copies 0/64 |
| `chain-sgsr` | 1 | 0,031 | 0,032 | 0,034 | 3,5 | 3,492 | copies 64/64 |
| `chain-nis` | 1 | 0,031 | 0,032 | 0,035 | 4,2 | 3,183 | copies 64/64 |
| `chain-fsr1` | 1 | 0,030 | 0,032 | 0,036 | 3,5 | 3,599 | copies 64/64 |

**`x1-chain-tick` — la même chaîne à 60 i/s**

| Cellule | passes | GPU p50 | p90 | p99 | disp. % | mur / draw | copies |
|---|---|---|---|---|---|---|---|
| `chain-off` | 1 | 0,032 | 0,033 | 0,036 | 2,7 | 3,821 | 0/64 |
| `chain-sgsr` | 1 | 0,032 | 0,034 | 0,178 | 3,1 | 3,588 | 64/64 |
| `chain-nis` | 1 | 0,032 | 0,033 | 0,210 | 0,9 | 3,217 | 64/64 |
| `chain-fsr1` | 1 | 0,032 | 0,034 | 0,037 | 1,6 | 3,524 | 64/64 |

**`x2-flip` — 1280×720 → 2560×1440 et 1280×720 → 1280×720, une image sur deux**

| Cellule | passes vues | copies | 1 passe (la copie 720p) p50 | N passes (le noyau à ×2) p50 | P0, `chain-*` à ×2 | disp. % | mur / draw |
|---|---|---|---|---|---|---|---|
| `chain-off` | 1 : 64 | 0/64 | 0,032 | — | 0,030 | 1,5 | 4,265 |
| `chain-sgsr` | 1 : 32, 2 : 32 | 32/64 | 0,012 | 0,091 | 0,088 | 1,0 | 4,972 |
| `chain-nis` | 1 : 32, 2 : 32 | 32/64 | 0,012 | 0,450 | 0,448 | 0,1 | 6,085 |
| `chain-fsr1` | 1 : 32, 3 : 32 | 32/64 | 0,013 | 0,262 | 0,262 | 0,3 | 5,302 |

**Lecture.**

1. **À 1:1, la chaîne du produit coûte ce que coûte `off`.** SGSR1, NIS et FSR1 à 0,030-0,032 ms
   contre 0,032 pour `off`, c'est-à-dire la cellule `blit` (0,030) et le plancher d'un bilinéaire
   (0,028) : une écriture du canvas, rien d'autre. L'écart à `off` (−3 à −6 %) est dans la
   dispersion des cellules (1,3-4,2 %). Avant P1, les mêmes passes à l'échelle 1 sur la même image
   coûtaient 0,109 / 0,380 / 0,289 ms : **÷ 3,5, ÷ 12, ÷ 9**.
2. **À 60 i/s, pareil** : 0,032 ms pour les quatre chaînes. Les p99 de 0,18-0,21 ms de `chain-sgsr`
   et `chain-nis` sont le bruit de la texture externe en régime espacé que P0 avait déjà vu (§3 du
   rapport P0), intermittent (absent sur `fsr1` et `off` ce tour-ci) et sans rapport avec P1.
3. **Le passage 1:1 ↔ ×2 à chaque image ne perd rien.** 64 draws sur 64 dans chaque cellule,
   alternance stricte (32 copies, 32 passages du noyau), aucune erreur ; le noyau à ×2 retrouve les
   chiffres de P0 à 0,003 ms près (0,091 / 0,450 / 0,262 contre 0,088 / 0,448 / 0,262) : le
   changement de régime ne coûte rien au GPU et ne laisse rien derrière lui (pas de pipeline
   reconstruit, pas de bind group perdu). La copie à 720p vaut 0,012 ms.
4. **Le temps mur par `draw()` reste la soumission** : 3,2-4,0 ms sur toutes les chaînes à 1:1,
   `off` compris, pour 0,03 ms de GPU — le constat de P0, intact, et c'est ce que la seconde moitié
   de P1 et la porte P4 mesurent. En bascule, +1 ms par draw (4,3-6,1) : chaque `setOutputSize`
   redimensionne l'`OffscreenCanvas` et reconfigure la surface, un coût du test (le produit change
   de taille rarement : fenêtre, rotation), pas de la détection.

## 5. Porte C7 et ce qui reste

| C7 | Résultat |
|---|---|
| temps GPU du renderer = celui de `off` ± 5 % | **tenu** sur le RTX (0,030-0,032 contre 0,032, dans la dispersion), en lot et à 60 i/s ; SwiftShader concorde |
| aucune image perdue au passage 1:1 ↔ échelle | **tenu** : 64/64 draws, alternance stricte, aucune erreur, noyau à ×2 inchangé |
| overlay « Off (1:1) » | codé et testé (clé `stream.enhancerPassthrough`), pas visible au labo ; **vu le 21/10 sur la `--dev` de DualRTX** (frontend `11d1e2d2` ⊃ P1) : flux 2560×1440 sur un écran 2560×1440, enhancer WebGPU coché, l'overlay lit « Enhancer: Off (1:1) » et le journal `renderer=webgpu algo=sgsr` |

## 6. Plein écran, clic → photon (DualRTX, 21/10/2026)

Le créneau de 40 min donné par Bruno au matin du 21/10, la machine sans autre charge. Le
dispositif est celui du banc de latence du dépôt (`scripts/bench/` : `kiosk.ps1`, `cdp.py`,
`click-target.ps1`, `probe-run.ps1`, sonde `mwLatency` de `LatencyProbe.js`) :

- **Hôte** : la `--dev` de DualRTX (`build\MoonlightWeb.exe --dev --autostart`, frontend servi =
  `11d1e2d2` du worktree `mw-59dev`, qui contient P1 ; hash du fichier servi vérifié contre
  `git show`), relancée avec `latency_flag_enabled: true` pour le créneau et remise à `false`
  après (drapeau lu au démarrage seulement). Elle encode « Display 1 » (M27Q 2560×1440 à 120 Hz,
  NVENC sur le RTX 5060 Ti, HEVC, 60 i/s demandés) ; une fenêtre `still.html` animée sous la bande
  du drapeau y fait couler des images (sans elle, un bureau fixe à 2 i/s laisse la sonde sans image
  fraîche avant la moitié des clics : « no picture to sample »).
- **Client** : Chrome 155 de banc, profil dédié, `--mute-audio`, kiosque plein écran sur l'écran
  principal (DISPLAY5, 2560×1440 physiques), `--use-adapter-luid=0,88263` : `chrome://gpu` dit
  l'AMD Radeon 780M `*ACTIVE*` et `requestAdapter()` rend l'AMD (`rdna`), donc décodage et rendu sur
  l'iGPU, jamais sur le GPU qui encode ; l'écran étant sur le RTX, la présentation traverse les
  adaptateurs, **pareil pour les trois présentateurs**. Flux en résolution `auto` = 2560×1440 :
  canvas 2560×1440 à 2048×1152 CSS (DPR 1,25), **1:1 exact**.
- **Les trois présentateurs**, par les réglages du client (`mw-streaming-settings`) : Canvas2D
  (enhancer off, le défaut) ; la copie 1:1 WebGPU (enhancer on, `sgsr` : journal
  `renderer=webgpu algo=sgsr`, overlay « Enhancer: Off (1:1) ») ; la copie 1:1 WebGL2 (enhancer on,
  `gl-sgsr`, `renderer=webgl2`).
- **La mesure** : un clic de chauffe jeté, puis 10 clics espacés de 1,5 s, attente 1 s ; séries
  entrelacées A/B/C ; pointeur hôte parqué sur la cible inerte. Les échantillons rejetés par la
  sonde (image absente avant le clic, drapeau non vu) sont écartés et comptés.

| Présentateur à 1:1 | séries (clics retenus) | médiane | moyenne | p90 | min – max | médianes par série |
|---|---|---|---|---|---|---|
| Canvas2D | 2 (11/20) | **26,9 ms** | 28,5 | 38,7 | 21,4 – 39,4 | 26,9 · 25,1 |
| copie 1:1 WebGPU (P1) | 3 (20/30) | **27,6 ms** | 29,7 | 39,6 | 19,3 – 51,9 | 21,7 · 27,9 · 27,3 |
| copie 1:1 WebGL2 | 3 (21/30) | **30,6 ms** | 29,7 | 36,4 | 20,2 – 41,5 | 31,5 · 28,1 · 24,0 |

Avant la fenêtre animée (bureau fixe, une série par présentateur, 4-5 clics retenus sur 10) :
Canvas2D 31,8, WebGPU 24,2, WebGL2 30,2 ms de médiane ; une série Canvas2D perdue quand un
premier kiosque de contenu plein écran a masqué le drapeau.

**Lecture.** Les médianes série à série d'un même présentateur bougent de ± 3 ms (la cadence de
capture rend la distribution bimodale, comme le banc du 06/09 l'avait noté) : les trois
présentateurs sont **égaux à cette précision**, et l'écart de 1 ms du critère du plan n'est pas
résoluble avec 10 clics par série. La copie 1:1 WebGPU ne coûte rien de mesurable au clic → photon
par rapport à Canvas2D ; le « 4 ms de soumission WebGPU » du labo est une latence de pipeline que
le clic → photon absorbe à 60 i/s (le temps mur de `draw()` n'est pas sur le chemin critique du
photon tant qu'il tient dans la période). Le jumeau WebGL2 est au même niveau.

**Reste de P1** : la décision de Bruno, blit (le contournement tel quel, dans les deux
renderers) ou deux canvas (hors v0.4.1 sinon). **Recommandation : blit** — aucun écart mesurable,
rien à construire, et le choix de Canvas2D quand l'enhancer est éteint reste celui d'aujourd'hui.
