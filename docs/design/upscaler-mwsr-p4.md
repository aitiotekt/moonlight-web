# Upscaler `mwsr` — rapport de la phase P4 (intégration et jumeau WebGL2)

Plan : `upscaler-mwsr.md` (§3.6 le jumeau, §4.3 les régimes, §12.1 P4). Rapports précédents :
`upscaler-mwsr-p0.md` à `-p3.md`. Journal du labo : `scripts/bench/scaler-lab/journal.md` (J17 à J20).
Session « Shader Upscaler », 21/10/2026 après-midi, Fable 5.1 `max` (gardé par Bruno après le
`/compact` de fin de P3). Commits `e965e9f9` (WebGPU), `031805ab` (jumeau GLSL et conformité),
`83aedfad` (échelle, menu, drapeau), `48bb8213` (CI), `18fb5409` (la porte : instrument, jeu `--p4`, tolérance CI).

## 1. Ce que P4 a construit

- **`mwsr` dans `WebGpuRenderer`** (`algo: 'mwsr'`) : un pipeline par régime (`mwsrRegimes()` :
  le noyau `up`, et les grilles de la réduction), tous construits à la création et spécialisés par
  `override` (`CHROMA444` quand le flux est 4:4:4, `R_DOWN` et `LINEAR_LIGHT` pour les grilles),
  le régime choisi par image par `mwsrRegime()` depuis la taille de l'image et celle du canvas, le
  bloc d'uniformes réécrit quand ces tailles changent, deux bind groups gardés avec la texture
  d'entrée. En SDR le canvas et la texture de la passe 0 sont créés avec leur format de vue `-srgb`
  (`viewFormats`) ; la réduction lit et dessine à travers ces vues, donc un échantillon bilinéaire
  est tout le filtre jusqu'à ×0,5, en lumière linéaire exacte, au coût de la copie (J15). Si le
  navigateur refuse les formats de vue, ou si le canvas est flottant (HDR), la réduction retombe sur
  la lumière logicielle et la grille 2×2. Le module f16 (`half`) est demandé à tout adaptateur qui a
  `shader-f16` et n'est pas NVIDIA (`WebGpuRenderer._requestDevice`), HDR compris ; le drapeau
  `yuv444` descend de `StreamView` et du worker.
- **Le jumeau GLSL ES 3.00** : `mwsrGlsl()` écrit le texte de chaque mode depuis les mêmes tables que
  `mwsrWgsl()` (les overrides cuits en constantes, deux `vec4` pour le bloc d'uniformes, `mediump`
  sur les couleurs et les poids du chemin contour) ; `WebGlRenderer` le joue sous la clé `gl-mwsr`,
  un programme par régime, le régime par image comme sur WebGPU ; la réduction y moyenne en lumière
  logicielle (un tampon WebGL2 n'a pas de vue sRGB). Les deux renderers rangent le pipeline ou le
  programme d'un régime sous la même clé (`mwsrRegimeKey()`).
- **L'échelle, le menu, le drapeau** : `mwsr` entre dans `ENHANCER_LADDER` entre `sgsr` et `off`
  (il coûte moins que SGSR1 sur tout GPU mesuré, 0,4 à 0,8 ×, pour la netteté de FSR1 : une session
  descendue garde une image nette un cran de plus) ; la mémoire du gouverneur range des noms, rien à
  migrer. `StreamView` route `mwsr` et `gl-mwsr` comme les trois ports (le HDR déplace la saveur
  WebGL2 vers WebGPU, l'overlay nomme les deux), le menu debug offre les deux saveurs (en, fr, zh),
  et `auto` prend `mwsr` dans les deux saveurs derrière le drapeau `localStorage.mw_mwsr = '1'`
  (`BrowserDetect.mwsrPreferred`) jusqu'à la décision de P6. Sans le drapeau, rien ne change pour
  `auto`.
- **Le labo** : la chaîne du produit avec la clé (`chain-mwsr`), la chaîne WebGL2 (`chain-gl-<passe>`,
  jeu `glchain`), captures et dumps des cellules chain (côté WebGPU la texture que le renderer a
  dessinée, relue sur son device par un crochet sur `getCurrentTexture` : le bitmap présenté revenait
  noir sur un runner Linux, J19 ; côté WebGL2 le tampon de dessin), images RGBA faites des mires avec
  `codec=none` (les texels exacts de la texture d'entrée),
  `chain-mwsr` dans les dorés ; le flux de conformité (`scaler_lab.py --conformity`, `p4_flows.py`) ;
  un mode `gl=1` de la page (WebGL2 seul, dumps par un canvas 2D) pour le Chrome où WebGPU est éteint ;
  un chien de garde du pilote (`--page-timeout`) ; le bouton `mwsr:fine=1`.
- **La CI** : un job `scaler-lab` (non bloquant) joue la conformité sur les adaptateurs logiciels d'un
  runner hébergé (Chrome stable, Python : websocket-client, numpy, Pillow, scikit-image) : chaque
  texte de shader que construisent les renderers y compile, la chaîne WebGPU donne l'image du noyau,
  le jumeau la même qualité. Le pilote trouve Chrome par `MW_CHROME` ou le PATH hors de DualRTX.

## 2. L'intégration WebGPU, vérifiée au pixel

Sur SwiftShader (`--swiftshader --golden`), la cellule `chain-mwsr` — le `WebGpuRenderer` du produit
sur un `OffscreenCanvas`, passe 0 comprise — a **l'empreinte exacte** du noyau (`mwsr`) sur les six
cas d'agrandissement (texte, jeu, code ; ×2 et ×1,33) et celle de la réduction par vues sRGB
(`mwsr:srgb=1`) sur les trois cas à ×0,5 (texte, zone-plate, code) : neuf sur neuf, `golden.json`
régénéré, les empreintes des autres cellules inchangées. Les vues sRGB du produit font donc ce que la
cellule du labo faisait ; le coût (le plancher) a été confirmé au GPU en P3 (J15, 14:33).

Deux détails du chemin : la table calculée (`LINEAR_LIGHT 1`, 2×2) sert quand `ctx.configure`
refuse `viewFormats` (essai dans un `try`, repli silencieux avec un avertissement console) et sur le
canvas `rgba16float` du HDR `linear` ; l'adaptateur NVIDIA n'a pas le module f16 (`half` n'y gagnait
rien, P2.3), les autres l'ont dès que `shader-f16` est là.

## 3. Le jumeau GLSL et la conformité (C11)

Le premier passage de conformité (SwiftShader, les deux côtés) a trouvé trois choses.

1. **`dFdy` de GL est `dpdy` de WebGPU changé de signe** : la fenêtre GL a son y vers le haut, le
   framebuffer WebGPU vers le bas. Sans la négation, la normale du contour sortait en miroir et les
   taps « le long » et « en travers » s'échangeaient sur toute diagonale : texte ×2 à 27,7 dB du noyau,
   28 % des pixels différents, écart maximal 221/255. Corrigé dans `mwsrGlsl()` (texte et test).
2. **Le dump d'une chaîne dessinait l'image du clip où en était le curseur** (le carré mobile des
   mires ailleurs que dans l'image des cellules du noyau : un bloc de 30×30 à 174/255). Les dumps et
   captures des chaînes dessinent maintenant la première image.
3. **La ligne de référence des dérivées « coarse » est le choix de l'implémentation**, et il diffère
   entre les deux espaces fenêtre : après la correction du signe, texte ×2 reste à 34,3 dB du noyau,
   25 % des pixels différents, 17 % au-delà de 2/255, maximum 76/255 ; les pixels plats concordent
   (0,6 % différents, par le vote au seuil), les pixels de contour diffèrent à 44 % mais **autant
   d'un côté que de l'autre de la bilinéaire** (écart moyen à la bilinéaire 20,55 contre 20,54/255,
   même côté 86 %). Le bouton `mwsr:fine=1` (dérivées `dpdxFine`/`dpdyFine` en WGSL) montre la
   sensibilité : le noyau coarse et le noyau fine diffèrent de 13 % des pixels au-delà de 2/255
   (max 83), et le GL n'est ni l'un ni l'autre (13,1 % contre fine, 16,9 % contre coarse). Ce n'est
   pas un bug de port : la direction du contour vient d'une estimation par quad dont la ligne de
   référence n'est pas spécifiée ; deux GPU différents sous le même WGSL peuvent différer autant.

Le critère C11 (« écart maximal WGSL/GLSL ≤ 2/255 ») est donc **reformulé en deux volets** dans le
flux de conformité :

- **pixels**, là où aucune dérivée n'intervient : la réduction. Mesuré : ≤ 1/255 sur texte et code à
  ×0,5 (2,2-4,5 % des pixels différents d'un niveau), 3/255 sur 0,009 % des pixels de la zone-plate
  (précision sous-texel différente des deux échantillonneurs : la tolérance admet 2/255 sur 99,9 % des
  pixels et 4/255 au plus). La chaîne WebGPU, elle, est tenue à l'identité : 0/255 sur les neuf cas ;
- **qualité égale face à la vérité terrain** pour le noyau (le flux `--quality` : mire au format de
  sortie, réduite Lanczos-3 en lumière linéaire vers l'entrée, ×2, texte, jeu, code) :

| contenu | | PSNR dB | SSIM | dépassements | FLIP |
|---|---|---|---|---|---|
| texte | `mwsr` WGSL | 17,41 | 0,8415 | 0 % | 0,071 |
| | `gl-mwsr` GLSL | 17,44 | 0,8425 | 0 % | 0,071 |
| | (bilinéaire / SGSR1 source / FSR1) | 16,99 / 17,81 / 17,57 | 0,816 / 0,857 / 0,845 | 0 / 2,3 / 0,3 % | 0,090 / 0,065 / 0,068 |
| jeu | `mwsr` WGSL | 35,84 | 0,8816 | 0 % | 0,019 |
| | `gl-mwsr` GLSL | 35,84 | 0,8816 | 0 % | 0,019 |
| | (bilinéaire / SGSR1 / FSR1) | 35,01 / 35,52 / 35,55 | 0,880 / 0,882 / 0,887 | 0 / 0,7 / 0,03 % | 0,020 / 0,018 / 0,017 |
| code | `mwsr` WGSL | 26,95 | 0,9555 | 0 % | 0,029 |
| | `gl-mwsr` GLSL | 26,96 | 0,9559 | 0 % | 0,029 |
| | (bilinéaire / SGSR1 / FSR1) | 26,96 / 26,86 / 27,35 | 0,953 / 0,945 / 0,951 | 0 / 4,9 / 1,3 % | 0,034 / 0,026 / 0,024 |

Le jumeau GLSL vaut le noyau WGSL à 0,000 FLIP, 0,025 dB et 0,001 SSIM près (seuils du flux : 0,002
FLIP, 0,1 dB, 0,1 % de dépassements) — et les deux se placent où P2 avait mis le noyau : entre le
bilinéaire et FSR1, sans dépassement. **C11 tenu sous cette forme.**

Pourquoi deux Chromes : forcer ANGLE sur SwiftShader (`--use-gl=angle --use-angle=swiftshader`)
éteint WebGPU dans ce Chrome, adaptateur de secours compris (essayé avec `--ignore-gpu-blocklist`,
`--use-webgpu-adapter=swiftshader` : `requestAdapter` rend `null`). Le côté WebGL2 tourne donc dans
son propre Chrome (`--webgl-swiftshader`, page en mode `gl=1`), le côté WebGPU dans le sien
(`--swiftshader`), chacun déposant ses dumps sous les mêmes noms, et le flux compare ce qui est sur le
disque ; sur un GPU (un Chrome pour les deux) un seul passage fait tout. Le premier essai, qui laissait
WebGL sur le GPU par défaut de la machine dans le Chrome du labo, pendait sans fin (une promesse jamais
résolue retenait le pilote, dix minutes perdues) : d'où le chien de garde `--page-timeout`, qui imprime
le journal de la page et fait échouer le cas.

## 4. Ce que P4 laisse

- **La porte P4** (`high`, plan §12.1) : WebGPU contre WebGL2 avec le nouveau shader, par classe
  d'appareil. *[Faite sur ordinateur le 21/10 au soir, §5 : WebGL2 reste la saveur SDR sur RTX et 780M ;
  le drapeau `mw_mwsr` vérifié sur la `--dev`. Restent le Mac, l'iPhone, le realme et `mw-arm` aux
  créneaux de Bruno, par les liens `--serve --p4`.]*
- **La réduction du jumeau WebGL2** moyenne en lumière logicielle (grille 2×2, 1,7 à 2,2 × le
  plancher sur le 780M, J14) là où le WebGPU a ses vues au prix du plancher. *[Mesuré à la porte, §5 :
  4K → 1440p sur le 780M, GPU 1,98 ms (WebGL2) contre 1,57 (WebGPU), `done` 9,3 contre 7,6 ms — le seul
  cas où WebGPU gagne sur ordinateur.]* Une piste, à mesurer et non à livrer à l'aveugle : téléverser la
  `VideoFrame` dans une texture `SRGB8_ALPHA8` (l'échantillonneur décode) et encoder la sortie dans le
  shader (trois `pow` par pixel), si le chemin de téléversement de Chrome reste le rapide sur ce format
  interne.
- **Le realme** : `ext-mwsr` (l'externe y est RGBA : la passe 0 — 0,9 ms — serait évitable sur cette
  famille d'Android, décision par `frame.format`) ; le 4×4 sous ×0,25.
- **`malioc`** sur le texte GLSL (reporté depuis P2.2) : non installé sur DualRTX.
- **Validation statique** : aucun compilateur WGSL ou GLSL n'existe sous Node ; les tests `vitest`
  tiennent la structure des textes (constantes partagées, offsets des grilles, dérivées avant la
  branche, niveau explicite, rien d'interdit) et le job CI les compile pour de vrai sur SwiftShader.
- **La ligne de référence des dérivées** : si P5 montre une différence visible entre GPU (le même WGSL
  sur Apple, NVIDIA, AMD, Mali), le vote pourra prendre `dpdxFine`/`dpdyFine` (le bouton existe) ou
  un gradient symétrique à deux échantillons de plus ; rien ne l'indique aujourd'hui.

## 5. La porte : WebGPU contre WebGL2 à shader égal (21/10/2026 au soir)

**Méthode** (journal J20, `scaler_lab.py --p4`, `p4_flows.py`, commit `18fb5409`). Les chaînes du produit `off`, SGSR1,
FSR1 et `mwsr` dans les deux renderers, sur les mêmes images H.264 décodées, cinq cas (×2 texte, jeu,
interface ; ×1,33 ; ×0,67 depuis la 4K), saturé et à 60 i/s, 48 draws par chaîne en deux tours ABBA.
Trois chiffres par draw : `submit` (le thread principal), `done` (du début du draw à la fin du GPU :
`onSubmittedWorkDone` côté WebGPU, une barrière sondée côté WebGL2 — `gl.finish()` de Chrome n'attend
rien) et `gpu` (les passes horodatées ; `EXT_disjoint_timer_query_webgl2` côté WebGL2, téléversement
compris). Chrome sans tête épinglé par LUID, sonde des deux API avant chaque jeu, un GPU à la fois au go
de 59. La règle de verdict (`GATE_WIN`, `GATE_MAIN`) : une saveur gagne quand son `done` p50 est sous
0,9 × l'autre sur ×2 texte, ×2 jeu et ×1,33 et que son thread principal n'est pas pire de plus d'un
cinquième ou d'un quart de milliseconde ; sinon égalité, et la saveur de production reste.

**Résultat** (`done` p50 à 60 i/s, WebGPU / WebGL2, ms ; `gpu` entre parenthèses) :

| cas | RTX 5060 Ti | Radeon 780M |
|---|---|---|
| ×2 texte, `mwsr` | 4,29 / 2,01 (0,07 / 0,34) | 5,61 / 4,75 (1,59 / 1,38) |
| ×2 jeu, `mwsr` | 3,99 / 1,77 (0,05 / 0,09) | 5,00 / 4,25 (0,81 / 0,81) |
| ×2 interface, `mwsr` | 4,22 / 1,96 (0,05 / 0,09) | 5,45 / 4,13 (0,84 / 0,83) |
| ×1,33 texte, `mwsr` | 4,09 / 2,16 (0,14 / 0,12) | 6,30 / 5,80 (1,57 / 1,40) |
| ×0,67 texte, `mwsr` (réduction) | 4,59 / 3,28 (0,21 / 0,23) | **7,59 / 9,30** (1,57 / 1,98) |
| ×2 texte, `off` (la copie) | 4,37 / 2,09 (0,03 / 0,12) | 4,62 / 4,09 (0,53 / 0,66) |
| ×2 texte, FSR1 | 4,65 / 3,23 (0,57 / 1,42) | 13,34 / 10,55 (9,42 / 7,92) |
| saturé, `mwsr` ×2 texte | 3,70 / 0,81 | 4,11 / 3,47 |
| thread principal p50, `mwsr` ×2 texte | 0,33 / 0,26 | 0,31 / 0,36 |

Le shader est à égalité sur le GPU (±15 %, le WebGL2 comptant le téléversement) ; ce qui sépare les
saveurs est la chaîne autour du shader : import de la texture externe, soumission et attente de la fin
du GPU coûtent 4 ms sur le RTX quelle que soit la passe (`off` : 0,03 ms de GPU pour 4,4 ms de `done`),
0,5 à 1,3 ms de plus que WebGL2 sur le 780M. **Verdict ordinateur au labo : WebGL2 reste la saveur SDR** — RTX
1,9 à 2,3 × à 60 i/s et 4 × saturé ; 780M 1,1 à 1,2 × (égalité dans les marges, la production reste). Une
exception à peser en P6 : la réduction 4K → 1440p sur le 780M, où les vues sRGB et un import 4K moins
cher donnent WebGPU 18 % plus tôt (7,6 contre 9,3 ms) — sur le RTX, où le GPU n'est pas le goulot,
WebGL2 garde l'avantage même là. Ce n'est **pas** la réponse à la question laissée ouverte par le wiki
15.3 (corrigé le 22/10, journal J27) : le labo s'arrête à la fin du GPU, avant le compositeur, alors que
le wiki mesurait au clic-photon, où le plein écran ×2 donnait WebGPU 5 à 10 ms devant WebGL2 ; à 1:1, les
trois présentateurs y sont égaux à 3 ms près et les 4 ms de soumission WebGPU du labo n'y paraissent pas
(rapport P1 §6). Ce que le labo établit : à shader égal sur le GPU, l'écart entre les saveurs ne vient pas
du shader. Le choix de la saveur, lui, se prend au clic-photon.

**Le drapeau `mw_mwsr` sur la `--dev`** (22:04-22:14, `--dev` de 09e31b38 vérifiée au hachage, client
Chrome sans tête tout SwiftShader puis ANGLE sur l'AMD épinglé + WebGPU sur SwiftShader, décodage
logiciel, flux de l'écran 1) : `auto` + drapeau → « WebGL MWSR » ; `auto` sans drapeau → « WebGL FSR1 » ;
`gl-mwsr` → « WebGL MWSR » ; `mwsr` sans WebGPU → Canvas2D ; `mwsr` avec WebGPU → « MWSR », renderer créé
avec les vues sRGB, image vive ; flux à la taille du canvas → « Off (1:1) ». Aucune erreur console. Le
menu debug des deux saveurs n'apparaît qu'en mode debug du serveur (non touché) : les tests unitaires le
couvrent.

**La porte sur les appareils de Bruno (22/10 au matin, journaux J23-J26).** Mêmes cas, mêmes règles,
`--screen` à la taille de chaque écran ; les liens servis pour les téléphones (`--serve`, dix-huit pages
ouvertes par Bruno), un Chrome sans tête piloté par `--remote-cdp` à travers un tunnel SSH pour le Mac et
`mw-arm`.

- **iPhone 13 Pro (Safari, iOS 26.5) : WebGPU gagne partout**, `done` 0,25-0,53 × WebGL2 dans les deux
  régimes et à la taille de l'écran, 0,13 × en réduction 4K. La cause est l'envoi de l'image : sur WebKit,
  `texImage2D` d'une VideoFrame coûte au fil principal 3,1 ms à 720p, 6,7 à 1080p, 19-24 ms à 4K, quand
  l'import WebGPU est quasi gratuit ; en WebGL2 l'iPhone ne tient pas 60 i/s dès une entrée 1080p.
- **Mac M1 Pro (Chrome 155) : WebGL2 reste.** Saturé, WebGPU 0,50-0,60 × ; à 60 i/s égalité dans les
  marges (WebGPU 1,05-1,40 ×, fil principal 0,54-0,67 ms contre 0,19-0,25) → la saveur de production
  reste ; même lecture que sur RTX et 780M. Safari macOS non mesuré.
- **`mw-arm` (Adreno 618) : WebGL2 par nécessité**, pas de WebGPU ; `gl-mwsr` y tourne sans erreur, tient
  60 i/s (FSR1 non) et coûte 0,63-0,77 × SGSR1 sur texte, jeu et ×1,33, égal sur l'interface : C1 tenue.
  Huit cas sur dix-huit, mw-arm ayant quitté le réseau en cours de passe ; les manquants ne changent pas
  la lecture.
- **realme Note 60 (Mali-G57 MP1, Chrome Android) : égalité**, WebGPU 0,78-0,98 × dans les deux régimes,
  fil principal égal → WebGL2 reste sur Mali ; seule la réduction 4K → 1440p donne WebGPU (0,39 ×, vues
  sRGB). À 1440p de sortie (3,2 écrans de ce téléphone) aucune saveur ne tient 60 i/s : le plancher de la
  chaîne y est 22 ms et `mwsr` ajoute 7-15 ms ; à sa taille, `mwsr` vaut 5,9 ms (J16). Dix-sept pages,
  ouvertes sur les liens de l'iPhone en parallèle de lui, puis les huit cas à la taille de son écran
  (1600×720, journal J26, addendum) : là **WebGPU passe devant partout**, 0,87-0,90 × à ×2, 0,76-0,86 ×
  à ×1,33, 0,50 × en réduction depuis 2400×1080 (2 à 6 ms de moins par image, 18 en réduction), fil
  principal égal. L'avance vient du plancher de la chaîne (`off` 15 ms contre 19 : l'import et la
  présentation), pas du shader ; la règle y dirait encore « égalité », de justesse (texte ×2 à 0,90), et
  aucune des deux ne finit son image sous 16,7 ms (`done` 18-21 ms contre 20-37).

Proposition de décision par classe (plan §9, P6, à Bruno) : ordinateur Windows, Mac dans Chrome et Mali →
WebGL2 (`gl-mwsr`) ; Apple mobile (WebKit) → WebGPU (`mwsr`) quand il est là, `gl-mwsr` sinon ; Snapdragon
→ `gl-mwsr` à la place de SGSR1 dans l'Auto. Mali reste en WebGL2 selon la règle, mais la mesure à la
taille de l'écran rend WebGPU défendable sur Mali aussi (2 à 6 ms de moins par image, 18 quand le flux
dépasse l'écran) : au choix de Bruno. Le labo n'a pas mesuré Safari macOS. *[Décidée par Bruno le
22/10 (plan §9), après le clic-photon ci-dessous : la proposition, sauf pour les Mali d'entrée de
gamme, sans upscaler automatique et présentés par WebGPU.]*

**Clic-photon des téléphones** (22/10, journal J28, go de Bruno après J27). La sonde `mwLatency` est
biaisée sur téléphone (WebGL2 relit ses pixels de façon synchrone après chaque dessin) : mesure refaite
sans relecture, un flash dans la page au clic, l'écran du téléphone enregistré, flash → drapeau.
- **iPhone 13 Pro** : pas de régression de WebGPU au photon (`mwsr` contre `gl-mwsr` : −6 ms en 720p
  ×1,13, +4 en 1080p réduit, intervalles à 90 % contenant zéro). En 1080p, WebGPU garde l'écran mesuré à
  120 Hz et le flux à 60 i/s verrouillé, quand WebGL le fait tomber à 56-58 i/s. « iPhone → WebGPU » tient.
- **realme** : l'échelle de l'amélioration coupe la passe en 2 s dans les deux saveurs à ×1,33 (elle ne
  tient pas une image ; la réduction n'a pas été rejouée échelle active, le labo P4 l'y place aussi
  au-delà d'une image). La saveur n'y choisit que le présentateur simple : égal à
  960×540, meilleur en WebGPU à 1080p (53-55 i/s contre 30). Passe maintenue de force au labo : `mwsr`
  arrive une image après `gl-mwsr` (médianes 41 contre 33 ms à ×1,33, 49 contre 33 en 1080p) mais montre
  presque deux fois plus d'images en 1080p ; deux séries identiques diffèrent elles aussi d'une image.
- **Décision de Bruno** (22/10, plan §9) : WebGPU sur iPhone ; sur les Mali d'entrée de gamme, aucun
  upscaler dans l'`auto` et le présentateur simple en WebGPU, amélioration activée ou non ; appliqué en P6.

**La CI** (run 39661997273, lu par 59) : sur le runner Linux, l'adaptateur logiciel forcé refuse
d'importer une image vidéo dans WebGPU (`importExternalTexture` : « Failed to import texture from
video » à chaque image), la chaîne WebGPU du produit n'y dessine rien ; limite de plateforme (sous
Windows le même SwiftShader importe, dorés et conformité exacts), hors de portée d'un utilisateur
(sans le drapeau, aucun adaptateur n'est offert et le client reste en WebGL2/Canvas2D). Le flux de
conformité tient désormais ce refus pour « non applicable sur cet adaptateur » et juge le reste (noyau,
jumeau WebGL2, dorés) ; le côté WebGL2 du job tourne même si le côté WebGPU a échoué. *[Décision de
Bruno du 22/10 (plan §9) : le job sortira en 0 quand ses seuls problèmes sont « non applicable », en 1
pour une vraie différence ou un dump manquant.]* *[Fait le 22/10 (journal J29), avec la CI rejouée sous
Linux dans le WSL de DualRTX : le noir venait du canvas WebGPU, qui ne peut pas présenter sur cette
plateforme (Chrome détruit le device et l'instance WebGPU de la page, le noyau du labo compris). Les
chaînes dessinent désormais dans une texture du labo : la chaîne WebGPU, entrée par le bitmap, y est
exacte sur les neuf cas. Reste une vraie différence propre à Linux, la réduction de la zone plate du
jumeau WebGL2 (l'échantillonnage WebGPU de SwiftShader y diffère, bilinéaire nu compris) : à Bruno.]*

**Le repli du renderer** (décision de Bruno du 21/10 au soir, relayée par 59 : avant la v0.4.1, pas en
P6 ; journal J21). Dès le premier refus, `draw()` copie l'image par `createImageBitmap` +
`copyExternalImageToTexture` dans sa texture d'entrée (la copie tient lieu de passe 0 ; la copie nue vers
le canvas lit la texture par un blit `texture_2d`), retente l'import tous les 300 draws, n'écrit qu'un
avertissement, et un draw qui échoue n'est plus journalisé qu'une fois par message. L'upscaler continue
de tourner ; rien ne change à l'écran ni dans l'overlay. Vérifié par un test à device simulé (cinq cas)
et au labo sur SwiftShader avec `importfail=1` : dorés exacts et conformité OK par le repli comme par
l'import. **Son coût, mesuré le 22/10 sur le 780M** (journal J21 ; `--p4 --extra importfail=1`, les mêmes
conditions que la porte) : `done` p50 de la chaîne `mwsr` ×1,2-1,3 celui de l'import à 720p → 1440p
(≈ +1 ms par image), ×1,8 avec une entrée 4K (le bitmap d'une image 4K, +5 à 6 ms), le fil principal pas
plus chargé (la création du bitmap est asynchrone) ; les cellules WebGL2 des deux passes, que le repli ne
touche pas, dérivent de 0,91 à 1,21. Un chemin de secours, jamais le chemin normal : acceptable.
*[Troisième repli décidé par Bruno le 22/10 (plan §9) : `VideoFrame.copyTo` vers RGBA puis
`writeTexture` ; après N échecs de suite, `gl-<algo>`, puis Canvas2D, au lieu du noir.]* *[Fait le 22/10
(journal J29) : la lecture après le bitmap ; 30 images perdues de suite, ou un device perdu avant sa
première image ou qui ne revient pas, et la page passe sur `gl-<algo>`, Canvas2D si WebGL2 refuse.
Dorés exacts par la lecture sous Windows et sous Linux.]*
