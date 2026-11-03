# Upscaler `mwsr` — rapport de la phase P0 (labo et lignes de base)

> Phase P0 du plan `upscaler-mwsr.md` (§6.4, §7, §9), jouée la nuit du 19 au 20/10/2026 sur
> DualRTX. Ce que P0 devait établir avant toute ligne de noyau : le coût de l'échantillonnage
> direct de la texture externe contre « passe 0 + RGBA » (décision n° 2 du §0), le coût des
> dérivées d'écran (la base du vote), la dispersion des horodatages GPU par machine, et les
> lignes de base des cinq techniques en place, chaîne telle que livrée et noyau seul.
> L'iPhone 13 Pro a été joué le 20/10 au matin, à un créneau de Bruno (§4 ter) ; le realme
> Note 60, le Mac M1 et `mw-arm` restent à jouer à ses créneaux : ce rapport couvre **deux GPU
> d'ordinateur et un téléphone Apple**.

## 1. L'instrument

`scripts/bench/scaler-lab/` : une page (`scaler-lab.html` + `scaler-lab.js`) et son pilote
(`scaler_lab.py`).

- **Les cellules** sont des chaînes de passes plein écran rendues dans une texture hors écran à
  la taille de sortie (le format du canvas, `bgra8unorm` sous Windows). Trois feeds, règle 1 du
  §7.1 : `ext-*` lit la `VideoFrame` décodée par une `texture_external` (aucune passe 0) ; `tex-*`
  lit une `rgba8unorm` déjà matérialisée (le noyau seul) ; `blit+*` paie d'abord la passe 0 du
  renderer (externe → `rgba8unorm`) puis le noyau : la chaîne que les enhancers WebGPU livrés
  paient aujourd'hui. `chain-*` pilote **le `WebGpuRenderer` du produit, inchangé**, sur un
  `OffscreenCanvas` (import, bind group par image, `draw()` attendu jusqu'à
  `onSubmittedWorkDone` comme la page le fait) ; ses passes sont horodatées de l'extérieur par
  des crochets sur les prototypes WebGPU (rien dans le produit).
- **Les shaders de référence sont lus dans le texte du module du produit** (`SGSR_WGSL`,
  `EASU_WGSL`, `RCAS_WGSL`, `NIS_WGSL`, `BLIT_WGSL`) : le labo mesure ce qui est livré. `sgsr-src`
  est le même port avec les constantes publiées par Qualcomm (seuil 8/255, netteté 2,0, delta
  borné à ±23/255), le témoin de la règle 6 du §7.1.
- **Les images** sont dessinées par la page à la taille d'entrée : `text` (trois colonnes de
  serif, comme `still.html`), `ui` (panneau sombre, cartes, lignes fines), `game` (dégradés,
  silhouettes nettes, grain, HUD). Les `VideoFrame` viennent d'une boucle WebCodecs
  encodeur → décodeur dans la page (H.264 High, 20 Mbit/s, matériel), avec un petit carré qui
  bouge pour que le clip ait des P-frames : la texture externe est une vraie **NV12 du décodeur**
  (`frame.format = "NV12"`, lue sans copie par Chrome, §2.7 du plan), pas une copie RGBA.
- **La mesure** : `timestamp-query` autour de chaque passe, Chrome lancé avec
  `--enable-webgpu-developer-features` (sinon les horodatages sont quantifiés à 100 µs) ; les
  itérations sont regroupées par lots de 16 dans un seul tampon de commandes, résolues une fois
  par lot, de sorte que l'aller-retour de la barrière n'entre jamais dans le chiffre GPU ; 2
  lots de chauffe, 8 lots mesurés, 3 tours entrelacés (ABBA), médiane, p90, p99, et la
  **dispersion** = écart des médianes de tour sur la médiane. `wall/iter` est en plus le temps mur
  `submit → onSubmittedWorkDone` ramené à l'itération. Le mode `pace=tick` soumet une itération
  toutes les 16,7 ms (le régime d'un flux à 60 i/s, horloges GPU au repos).
- Chrome 155.0.8059.84, sans tête (`--headless=new`), profil et drapeaux propres au labo, GPU
  choisi par `--use-adapter-luid` (les deux préférences `powerPreference` rendent le RTX sur
  cette machine ; le 780M n'est atteint que par son LUID, lu par `IDXGIFactory1`).
- **Les téléphones** : `scaler_lab.py --serve 0.0.0.0:8766` sert le dépôt en HTTPS (certificat
  auto-signé aux adresses du LAN : WebGPU exige un contexte sécurisé) avec des liens courts (`/1`
  à `/6`) vers les cas de `PHONE_CASES` ; la page tourne dans le navigateur du téléphone, affiche
  « posted » et renvoie son JSON (`post=1`) au serveur, qui l'écrit en
  `bench-out/scaler-lab/phone-<tag>-<cas>-<horodatage>.json`. Une règle de pare-feu limitée au
  port est ouverte pour le créneau et retirée après. Les cas `-single` soumettent une itération
  par tampon de commandes (`pace=tick&period=0.01`) : le §4 ter dit pourquoi.

Validation d'abord sur l'adaptateur logiciel (SwiftShader, règle « WARP d'abord ») : les 27
cellules compilent, dessinent (recadrages PNG relus) et s'horodatent avant tout GPU réel.

**La chaîne de qualité** (`--quality <image>`) : la page rend l'image à la taille de sortie
(`gt=1`, la vérité terrain, règle 2 du §7.1), le pilote la réduit à la taille d'entrée par un
Lanczos-3 en lumière linéaire (une fois, le même fichier pour toutes les cellules), fait tourner
les noyaux dessus (`tex-s1`, `sgsr-repo`, `sgsr-src`, `nis`, `easu`, `fsr1`, feed `texture_2d`, sans
compression), relit chaque sortie entière (`dump=`) et la note dans `metrics.py` : PSNR, SSIM
(fenêtre gaussienne ; sur le RGB, sur la luma, et sur le tiers central), **taux de dépassement**
(part des pixels qui sortent du min/max des quatre texels d'entrée qui les entourent de plus de
2/255 : la sonnerie, sans référence) et FLIP quand `flip-evaluator` s'importe. Deux mires
s'ajoutent aux images : `zone` (zone-plate jusqu'à Nyquist et réseaux de 1 à 6 px, pour la
réduction, C10) et `code` (syntaxe colorée sur fond sombre, pour les contours de chroma, C9).
Alignement vérifié : le bilinéaire du labo et celui de PIL sur la même entrée concordent à
58 dB, et tout décalage d'un pixel fait tomber le PSNR contre la vérité.

## 2. Le parc, relevé

| Machine | GPU | `adapter.info` | Fonctionnalités utiles au plan |
|---|---|---|---|
| DualRTX | RTX 5060 Ti | `nvidia blackwell 0x2d04` | `shader-f16`, `subgroups`, `subgroup-size-control`, `timestamp-query`, `float32-filterable`, `bgra8unorm-storage`, `dual-source-blending`, `texture-formats-tier2` |
| DualRTX | Radeon 780M | `amd rdna-2 0x13c0` (Chrome dit « rdna-2 » pour ce gfx1103) | la même liste que le RTX : `shader-f16`, `subgroups`, `timestamp-query`, `float32-filterable`, `bgra8unorm-storage`, `dual-source-blending`, `texture-formats-tier2` |
| DualRTX | Arc A380 | **débranchée** (Bruno, 20/10 ; absente de l'énumération DXGI dès le 19/10), compatibilité à vérifier à son retour | — |
| iPhone 13 Pro | Apple A15 (GPU 5 cœurs), iOS 26.5, Chrome iOS 155 = WebKit | `apple apple apple apple` (WebKit masque fournisseur, architecture et modèle) | `shader-f16`, `timestamp-query` (lecture particulière, §4 ter), `bgra8unorm-storage`, `float16-renderable`, `float32-renderable`, `float32-blendable`, `rg11b10ufloat-renderable`, `texture-formats-tier1`, ASTC et ETC2 ; **sans** `subgroups`, `float32-filterable`, `dual-source-blending`, `texture-formats-tier2` |

Décodeur WebCodecs : H.264 matériel sur les deux GPU de DualRTX et sur l'iPhone
(`prefer-hardware` honoré), sortie NV12 ; l'encodeur de l'iPhone étiquette ses images
`iec61966-2-1` en pleine plage (DualRTX : `bt709`, plage limitée).

## 3. RTX 5060 Ti

Dispersion tour à tour ≤ 1,7 % sur toutes les cellules en `back` ; horodatages à la
nanoseconde (0,007 ms se lit). Sortie 2560×1440 sauf la ligne ×1.

| Cellule (×2, 720p → 1440p) | texte | jeu | ×1,33 texte | ×1 texte (1080p) |
|---|---|---|---|---|
| `blit` (passe 0 seule, à la taille d'entrée) | 0,007 | 0,007 | 0,017 | 0,017 |
| `ext-s1` (1 bilinéaire sur l'externe) | 0,028 | 0,028 | 0,030 | 0,017 |
| `ext-s5` / `ext-s9` | 0,057 / 0,096 | 0,056 / 0,096 | 0,065 / 0,102 | 0,040 / 0,062 |
| `ext-l1` / `ext-l5` (`textureLoad` sur l'externe) | 0,028 / 0,066 | 0,028 / 0,066 | 0,031 / 0,071 | 0,018 / 0,041 |
| `ext-s1-fw` (1 bilinéaire + `fwidth` de la luma) | 0,028 | 0,028 | 0,033 | 0,019 |
| `tex-s1` / `tex-s2` (le plancher bilinéaire, et un 2ᵉ échantillon) | 0,028 / 0,028 | 0,028 / 0,028 | 0,028 / 0,028 | 0,016 / 0,016 |
| `tex-s5` / `tex-s9` | 0,047 / 0,084 | 0,047 / 0,085 | 0,047 / 0,085 | 0,026 / 0,047 |
| `tex-s1-fw` | 0,028 | 0,028 | 0,028 | 0,016 |
| `blit+tex-s1` / `blit+tex-s5` / `blit+tex-s9` | 0,037 / 0,056 / 0,093 | 0,037 / 0,056 / 0,093 | 0,050 / 0,069 / 0,106 | 0,034 / 0,045 / 0,066 |
| `sgsr-repo` / `sgsr-src` (noyau seul) | 0,073 / 0,073 | 0,066 / 0,066 | 0,066 / 0,066 | 0,039 / 0,039 |
| `nis` | 0,439 | 0,420 | 0,510 | 0,194 |
| `easu` / `rcas` / `fsr1` (EASU → interm → RCAS) | 0,187 / 0,056 / 0,247 | 0,188 / 0,056 / 0,246 | 0,188 / 0,057 / 0,247 | 0,104 / 0,031 / 0,137 |
| `blit+sgsr-repo` / `blit+fsr1` (la chaîne livrée, dans le labo) | 0,087 / 0,259 | 0,075 / 0,252 | 0,093 / 0,273 | 0,060 / 0,161 |
| `chain-off` / `chain-sgsr` / `chain-nis` / `chain-fsr1` (le renderer du produit, GPU) | 0,030 / 0,088 / 0,448 / 0,262 | 0,030 / 0,078 / 0,432 / 0,260 | — | — |
| `chain-*`, temps mur de `draw()` (import + barrière) | 2,66 / 3,94 / 4,27 / 4,15 | 2,25 / 3,65 / 3,51 / 3,55 | — | — |

Deux cas de plus sur le RTX : **×0,75 (1440p → 1080p, texte)** : `blit` 0,030 (la passe 0 écrit
l'entrée 1440p), `ext-s1` 0,020 contre `blit+tex-s1` 0,052, `ext-s5` 0,041 contre 0,063, `ext-s9`
0,062 contre 0,084 : en réduction la lecture directe gagne nettement, même ici ; `sgsr-repo` 0,039,
`fsr1` 0,137, `nis` 0,207. **×2 image d'interface** : `sgsr-repo` 0,038 (contre 0,073 sur le
texte : sa sortie anticipée joue), `nis` 0,309, `easu` 0,187 et `fsr1` 0,246 (sans sortie anticipée,
insensibles au contenu), feeds identiques au texte.

**Au régime d'un flux (`pace=tick`, une soumission toutes les 16,7 ms, ×2 texte)** : les
cellules `tex-*` gardent leurs chiffres (`tex-s1` 0,031, `sgsr-repo` 0,076, `easu` 0,188, `nis`
0,434) ; tout ce qui touche la texture externe ou enchaîne deux passes devient **bruyant** :
`ext-s1` 0,138 médian, p99 1,08 (dispersion 67 %) ; `blit` 0,014 médian, p99 0,22 ; `fsr1` 0,51
médian, p99 1,5 ; `blit+fsr1` 0,57 / 2,45. Et le temps mur par soumission est **3,3 à 3,8 ms quelle
que soit la cellule**, y compris `blit` à 0,014 ms de GPU : sur ce GPU, à 60 i/s, le prix d'une
image WebGPU est l'aller-retour de la soumission (processus GPU de Chrome, barrière), pas le
shader — c'est le « 4 ms Windows » du 03/09 retrouvé, et c'est ce que P1 et la porte P4
mesurent, pas P2.

**Ce que le RTX dit pour les quatre questions de P0.**

1. *Externe contre RGBA* : `ext-s1` = `tex-s1` = 0,028 ms, `ext-s5` 0,057 contre `blit+tex-s5`
   0,056, `ext-s9` 0,096 contre 0,093 : **à égalité**, la passe 0 ne coûte que 0,007-0,017 ms
   ici et l'échantillon externe ne coûte rien de plus que l'échantillon RGBA (le double fetch
   Y + UV est absorbé). `textureLoad` sur l'externe vaut l'échantillon (`ext-l1` 0,028) et un peu
   plus à cinq (0,066 contre 0,057). En `tick`, en revanche, l'externe est la source de tout le
   bruit (p99 1,08 ms contre 0,036 pour `tex-s1`) : la synchronisation avec le décodeur se paie
   par image et apparaît dans le temps de la passe.
2. *Dérivées* : `fwidth` de la luma coûte **zéro** (`tex-s1-fw` = `tex-s1`, `ext-s1-fw` =
   `ext-s1`), et un deuxième échantillon aussi (`tex-s2` = `tex-s1`) : la passe est bornée par
   l'écriture de la cible (14,7 Mo en 1440p), pas par le calcul ni par un fetch de plus. Le
   vote par dérivées est gratuit sur ce GPU.
3. *Dispersion* : ≤ 1,7 % en `back` ; 40-140 % sur les cellules externes en `tick`.
4. *Lignes de base, noyau seul à ×2* : bilinéaire 0,028 ; SGSR1 0,066-0,073 (2,4-2,6 × le
   plancher ; les constantes de Qualcomm ne changent rien au temps, comme leur README le dit) ;
   RCAS 0,056 ; EASU 0,19 ; FSR1 0,25 ; NIS 0,44. Chaîne livrée : SGSR1 0,088, FSR1 0,26, NIS
   0,45 ms (le renderer du produit, mesuré de l'extérieur, retrouve le labo à 0,01 ms près).

## 4. Radeon 780M (iGPU, mémoire partagée)

Dispersion tour à tour ≤ 2,6 % en `back` (5-6 % sur les deux cellules sous 0,5 ms). Le GPU
qui compte pour le plan : c'est lui qui ressemble à un portable ou à une tablette. GPU p50 en ms,
sortie 2560×1440 sauf les colonnes ×1 (1080p) et ×0,75 (1440p → 1080p).

| Cellule | ×2 texte | ×2 jeu | ×2 interface | ×1,33 texte | ×1 texte | ×0,75 texte |
|---|---|---|---|---|---|---|
| `blit` (passe 0 seule, à la taille d'entrée) | 0,114 | 0,109 | 0,114 | 0,254 | 0,253 | 0,450 |
| `ext-s1` | 0,462 | 0,437 | 0,433 | 0,453 | 0,259 | 0,300 |
| `ext-s5` / `ext-s9` | 1,324 / 2,214 | 1,322 / 2,223 | 1,321 / 2,218 | 1,371 / 2,313 | 0,794 / 1,349 | 0,862 / 1,495 |
| `ext-l1` / `ext-l5` | 0,557 / 1,751 | 0,558 / 1,756 | 0,559 / 1,755 | 0,564 / 1,758 | 0,319 / 0,990 | 0,331 / 0,992 |
| `ext-s1-fw` | 0,539 | 0,537 | 0,537 | 0,543 | 0,307 | 0,322 |
| `tex-s1` / `tex-s2` | 0,383 / 0,482 | 0,369 / 0,466 | 0,367 / 0,465 | 0,389 / 0,488 | 0,226 / 0,279 | 0,242 / 0,294 |
| `tex-s5` / `tex-s9` | 1,126 / 1,982 | 1,105 / 1,963 | 1,105 / 1,956 | 1,146 / 2,014 | 0,658 / 1,158 | 0,669 / 1,174 |
| `tex-s1-fw` | 0,465 | 0,451 | 0,447 | 0,468 | 0,271 | 0,282 |
| `blit+tex-s1` / `+s5` / `+s9` | 0,503 / 1,241 / 2,098 | 0,487 / 1,234 / 2,089 | 0,476 / 1,217 / 2,064 | 0,662 / 1,412 / 2,292 | 0,493 / 0,920 / 1,424 | 0,707 / 1,126 / 1,636 |
| `sgsr-repo` / `sgsr-src` | 2,475 / 2,486 | 2,477 / 2,489 | 1,110 / 1,109 | 2,142 / 2,146 | 1,275 / 1,282 | 1,278 / 1,284 |
| `nis` | 10,53 | 10,60 | 8,82 | 10,43 | 5,89 | 6,15 |
| `easu` / `rcas` / `fsr1` | 7,26 / 2,10 / 9,36 | 7,26 / 2,10 / 9,36 | 7,26 / 2,10 / 9,36 | 7,28 / 2,09 / 9,37 | 4,11 / 1,18 / 5,29 | 4,11 / 1,18 / 5,31 |
| `blit+sgsr-repo` / `blit+fsr1` | 2,81 / 9,48 | 2,61 / 9,48 | 1,26 / 9,47 | 2,66 / 9,65 | 1,62 / 5,56 | 1,88 / 5,77 |
| `chain-off` / `chain-sgsr` / `chain-nis` / `chain-fsr1` (renderer du produit, GPU) | 0,50 / 2,82 / 10,9 / 9,49 | 0,48 / 2,63 / 10,8 / 9,49 | — | — | — | — |
| `chain-*`, temps mur de `draw()` | 4,25 / 5,88 / 14,1 / 13,3 | 3,69 / 6,11 / 14,7 / 13,2 | — | — | — | — |

**Au régime d'un flux (`tick`, ×2 texte)** : tout ralentit de 1,2 à 2,6 × (horloges au repos) :
`tex-s1` 0,99, `ext-s1` 1,07, `sgsr-repo` 3,19, `easu` 8,03, `fsr1` 10,0, `nis` 11,1 ; dispersion
1-12 %, p99 proches des médianes (pas le bruit du RTX) ; temps mur par soumission 3,4 ms pour une
passe courte, 13,7 ms pour NIS. C'est le facteur « 1,5 à 3 × en régime établi » que le §2.6 du plan
annonçait, mesuré : 2,6 × sur le plancher.

**Lecture.**

- **Le plancher.** Une passe 1440p qui ne fait qu'un bilinéaire coûte 0,38 ms (17 Mo d'écriture
  et de lecture : ≈ 45 Go/s, la part de DDR5 d'un iGPU) : tout se paie au-dessus. Une passe 1080p
  0,23 ms.
- **La passe 0 coûte selon l'entrée** (0,11 ms à 720p, 0,25 à 1080p, 0,45 à 1440p) ; **l'échantillon
  externe coûte selon la sortie et le nombre de taps** : +0,08 ms pour 1 tap à 1440p, +0,20 pour 5,
  +0,23 pour 9 (les deux plans NV12 lus par échantillon, §2.7). D'où le verdict par cas, chaîne
  entière (`ext-sN` contre `blit+tex-sN`) :

  | | 1 tap | 5 taps | 9 taps |
  |---|---|---|---|
  | ×2 (720p → 1440p) | **externe −8 %** | passe 0 +7 % | passe 0 +5 % |
  | ×1,33 (1080p → 1440p) | **externe −32 %** | externe −3 % | égal |
  | ×1 (1080p) | **externe −47 %** | externe −14 % | externe −5 % |
  | ×0,75 (1440p → 1080p) | **externe −58 %** | externe −23 % | externe −9 % |

  Le noyau du plan lit **un** tap sur le plat et cinq sur les contours : sur tout contenu où les
  contours sont une minorité de quads, et sur tous les cas où l'entrée est grande (fenêtre, 1:1,
  réduction, c'est-à-dire l'usage ordinateur courant du §1.6), la lecture directe gagne ; elle ne
  perd que sur du texte dense à ×2 et de 5 à 7 %. **`textureLoad` sur l'externe coûte plus que
  l'échantillon** (0,56 contre 0,46 à 1 tap, 1,75 contre 1,32 à 5) : la borne exacte 2×2 de
  `DERING_EXACT` se fera par échantillons, pas par chargements, sur ce feed.
- **Les dérivées ne sont pas gratuites ici** : `fwidth` de la luma ajoute 0,08 ms à 1440p, à
  peu près un deuxième échantillon (`tex-s2` − `tex-s1` = 0,10) et moins de la moitié d'un
  échantillon de la croix (0,19 par tap au-delà du premier). Le vote par dérivées reste moins
  cher qu'un gather (SGSR1 : un bilinéaire + un gather = 2,5 ms sur ce contenu, soit 6,5 × le
  plancher, là où « un bilinéaire + `fwidth` » = 0,47, soit 1,2 ×).
- **Les lignes de base sont lourdes sur cet iGPU** : à ×2 vers 1440p, SGSR1 2,5 ms (6,5 × le
  plancher ; 1,1 ms sur l'image d'interface, où sa sortie anticipée joue ; identique sur « jeu »,
  dont le grain déclenche le vote partout), RCAS 2,1, EASU 7,3, **FSR1 9,4 ms**, **NIS 10,5 ms** ;
  à 1:1 en 1080p, FSR1 5,3 et NIS 5,9 ms pour recopier l'image. Dans le renderer du produit,
  `draw()` d'une image FSR1 prend 13 ms de temps mur, NIS 14 ms : à 60 i/s, l'enhancer seul
  mange la moitié du budget sur un 780M. La chaîne d'un bilinéaire (`chain-off`) : 0,5 ms de GPU,
  4,2 ms de mur — la soumission, comme sur le RTX.
- Les constantes de Qualcomm (seuil 8/255) ne changent pas le temps de SGSR1 (2,486 contre
  2,475).
- **Réserve** : ces chiffres absolus sont lents pour un 780M (Qualcomm donne SGSR1 à 0,3-0,5 ms
  sur Adreno vers 1080p-1600p) ; cet iGPU ne pilote aucun écran sur DualRTX et sa fréquence sous
  Chrome n'est pas connue. Les rapports entre cellules, mesurés dans les mêmes conditions, sont
  la donnée de P0 ; l'UM790Pro (même GPU, écran) recoupera les absolus en P5.
  - Correction du 29/10/2026 : ce n'était pas un 780M, mais l'iGPU du Ryzen 9 9900X, à 2 unités
    de calcul (plan B §9). Cela explique la lenteur. L'UM790Pro, elle, a un vrai 780M.

## 4 bis. Qualité : premiers repères des noyaux livrés

Mesurés d'abord sur l'adaptateur logiciel (SwiftShader : même WGSL, filtrage bilinéaire 8 bits),
puis **rejoués sur le RTX 5060 Ti le 20/10** : les deux concordent au centième de dB, le tableau
donne les chiffres du RTX. ×2 de 1280×720 vers 2560×1440, entrée = vérité réduite (Lanczos-3,
linéaire), sans compression. Les chiffres se
lisent **les uns contre les autres** : à ×2, du texte de 12 px à 720p est en grande partie
irrécupérable (le meilleur agrandissement de PIL, Lanczos, atteint 18,1 dB sur `text`).

| Noyau | `text` PSNR / SSIM / dépassement | `code` PSNR / SSIM / dép. | `game` PSNR / SSIM / dép. | `zone` PSNR / SSIM / dép. |
|---|---|---|---|---|
| bilinéaire (`tex-s1`) | 16,99 / 0,816 / 0 % | 29,97 / 0,977 / 0 % | 35,01 / 0,880 / 0 % | 10,41 / 0,423 / 0 % |
| SGSR1 du dépôt | 18,13 / 0,869 / 4,4 % | 29,65 / 0,974 / 2,6 % | 35,61 / 0,883 / 0,7 % | 10,80 / 0,491 / 0 % |
| SGSR1, constantes Qualcomm | 17,81 / 0,857 / 2,3 % | 29,87 / 0,972 / 2,5 % | 35,52 / 0,882 / 0,7 % | 10,79 / 0,484 / 0 % |
| NIS | 18,30 / 0,868 / 7,1 % | 28,20 / 0,970 / 4,0 % | 35,07 / 0,887 / 1,6 % | 10,88 / 0,507 / 27,7 % |
| EASU seul | 17,53 / 0,843 / 0 % | 30,32 / 0,976 / 0 % | 35,56 / 0,885 / 0 % | 10,71 / 0,471 / 0 % |
| FSR1 (EASU + RCAS) | 17,57 / 0,845 / 0,3 % | 30,36 / 0,975 / 0,7 % | 35,55 / 0,887 / 0,03 % | 10,79 / 0,484 / 3,4 % |

Ce que ces repères disent avant le noyau : sur le texte, SGSR1 et NIS gagnent 1,1-1,3 dB sur le
bilinéaire **en dépassant** (4-7 % des pixels sortent de la plage locale : la sonnerie qu'on
voit sur les serifs), FSR1 gagne 0,6 dB **sans dépasser** (la borne 2×2 d'EASU, puis RCAS tenu
par sa limite) ; sur le texte coloré, EASU et FSR1 sont les meilleurs (30,3 dB, chroma filtrée)
et NIS le pire (28,2) ; sur la zone-plate, NIS sonne sur 28 % des pixels. Le critère C3 (« FLIP ≤
FSR1 + 0,01 ») attend FLIP, qui n'a pas encore de roue pour Python 3.14 (compilation refusée) :
d'ici là, PSNR, SSIM et dépassements servent de garde-fous, et FSR1 est la référence de qualité à
égaler, SGSR1 celle à battre sur la sonnerie.

**L'étalon de Bruno.** `C:\Test\00_Background.png` (2560×1440) est l'image avec laquelle Bruno
compare ses agrandisseurs et réducteurs en SDR : un bureau Windows avec trois fenêtres de jeu
(course, Prince of Persia, Cyberpunk au centre), du feuillage fin, de la peau, de petites icônes
et un panneau de texte coloré sur noir. Le labo la sert sous `/test/` ; vérité = l'image
elle-même, à ×2 (entrée 720p) et ×1,33 (entrée 1080p), sur le RTX :

| Noyau | ×2 PSNR / SSIM / dép. | ×2 tiers central PSNR / SSIM | ×1,33 PSNR / SSIM / dép. | ×1,33 tiers central PSNR / SSIM |
|---|---|---|---|---|
| bilinéaire (`tex-s1`) | 20,78 / 0,863 / 0 % | 31,56 / 0,928 | 23,73 / 0,934 / 0 % | 36,36 / 0,977 |
| SGSR1 du dépôt | 20,59 / 0,853 / 6,8 % | 31,28 / 0,930 | 23,75 / 0,924 / 5,0 % | 34,55 / 0,970 |
| SGSR1, constantes Qualcomm | 20,61 / 0,849 / 8,6 % | 31,03 / 0,925 | 23,75 / 0,921 / 6,5 % | 33,95 / 0,966 |
| NIS | 20,15 / 0,824 / 21,7 % | 27,91 / 0,896 | 23,43 / 0,892 / 18,3 % | 30,24 / 0,942 |
| EASU seul | 20,79 / 0,874 / 0 % | 32,38 / 0,942 | 24,01 / 0,942 / 0 % | 36,58 / 0,980 |
| FSR1 (EASU + RCAS) | 20,79 / 0,874 / 2,0 % | 32,26 / 0,940 | 24,15 / 0,941 / 5,0 % | 35,94 / 0,976 |

Sur cette image, qui ressemble à ce que le produit affiche (jeu et bureau, pas une mire),
l'ordre change : **EASU et FSR1 sont les meilleurs partout** (SSIM 0,874 contre 0,863 au
bilinéaire à ×2, +0,8 dB sur le tiers central, qui est la fenêtre de jeu) ; **SGSR1 passe sous le
bilinéaire** en PSNR comme en SSIM (sa netteté sort 7-9 % des pixels de la plage locale et le
tiers central n'y gagne rien) ; NIS est nettement le pire (−0,6 dB, 22 % de dépassements : la
netteté livrée est trop forte pour une image de jeu). Le PSNR de l'image entière est écrasé par
les aplats du bureau (31-36 dB au tiers central pour 20-24 sur l'entier) : les verdicts de P2 se
liront sur le tiers central et sur SSIM en attendant FLIP, et cet étalon rejoint les contenus de
référence de la matrice (§7.3), à côté des mires.

## 4 ter. iPhone 13 Pro (Apple A15, WebKit), 20/10 au matin

Créneau de Bruno de dix minutes : la page servie depuis DualRTX en HTTPS, ouverte dans
**Chrome iOS 155.0.8059.37**, c'est-à-dire WebKit sous un autre habillage (iOS 26.5 ; Safari
donne la même pile WebGPU). Trois cas (`x2-text` avec la chaîne du produit, joué deux fois ;
`x075-text` ; `x2-game`), 2 tours × 6 lots de 16 itérations, 9 à 19 s de page chacun, aucune
erreur. Les tailles sont celles du banc d'ordinateur (sortie 1440p, 3,7 Mpx) ; l'écran du
téléphone fait 2532×1170 (3,0 Mpx) : les coûts par image à sa taille sont à lire 20 % plus bas.

**Les horodatages de ce GPU ne s'additionnent pas.** `timestamp-query` est exposé et rend des
nanosecondes, mais trois faits montrent que la durée d'une passe prise dans un tampon de seize
itérations n'est pas son coût :

- `nis` mesure 265 ms par passe alors que le lot de seize passes s'achève en 16 × 31 ms de temps
  mur (`submit → onSubmittedWorkDone`) ;
- la même passe `blit` (720p) mesure 0,08 ms seule, 0,7 ms devant `tex-s1`, 2,6 ms devant
  `tex-s5` et 4,8 ms devant `tex-s9` : sa « durée » suit ce qui vient après elle ;
- le premier tour d'une cellule légère vaut 1,5 à 13 fois le second (`blit` 1,00 → 0,08 ms,
  `ext-s1` 3,2 → 1,1) sans que le temps mur bouge.

C'est le comportement d'un GPU à tuiles dont le tileur ouvre la passe suivante pendant que le
rendu de la précédente court encore : le début d'une passe est pris tôt, sa fin tard, et plus le
tampon est long, plus les durées se recouvrent. Deux lectures restent justes : le **temps mur par
itération sous contre-pression**, qui borne par le haut le coût GPU réel à horloge pleine (le GPU
est saturé pendant le lot), et les cellules **`chain-*`**, une image par tampon de commandes, dont
les horodatages concordent avec le temps mur de `draw()`. Les cas `-single` (une itération par
tampon, `pace=tick&period=0.01`) ont été ajoutés au serveur pour le prochain créneau : ils rendent
les horodatages par passe lisibles sur ce GPU.

| cellule | passes | ×2 texte GPU p50 | ×2 texte mur/it | ×2 jeu GPU p50 | ×2 jeu mur/it | ×0,75 texte GPU p50 | ×0,75 texte mur/it |
|---|---|---|---|---|---|---|---|
| blit | 1 | 0,20 | 0,24 | 0,20 | 0,25 | 2,52 | 0,52 |
| ext-s1 | 1 | 1,57 | 0,47 | 1,27 | 0,36 | 1,94 | 0,46 |
| ext-s5 | 1 | 6,07 | 0,94 | 6,11 | 0,92 | 3,78 | 0,68 |
| ext-s9 | 1 | 11,35 | 1,57 | 11,38 | 1,52 | 6,50 | 0,98 |
| ext-l1 | 1 | 1,60 | 0,44 | 1,61 | 0,43 | 1,65 | 0,44 |
| ext-l5 | 1 | 6,43 | 0,99 | 6,41 | 0,97 | 3,87 | 0,73 |
| ext-s1-fw | 1 | 1,14 | 0,38 | 1,21 | 0,39 | 1,90 | 0,47 |
| tex-s1 | 1 | 0,96 | 0,27 | 0,95 | 0,28 | 2,48 | 0,46 |
| tex-s2 | 1 | 0,95 | 0,27 | 0,96 | 0,28 | 2,51 | 0,45 |
| tex-s5 | 1 | 2,92 | 0,48 | 3,02 | 0,51 | 2,61 | 0,46 |
| tex-s9 | 1 | 5,53 | 0,81 | 5,53 | 0,80 | 3,63 | 0,61 |
| tex-s1-fw | 1 | 1,04 | 0,33 | 0,93 | 0,27 | 2,42 | 0,43 |
| blit+tex-s1 | 2 | 1,48 | 0,44 | 1,45 | 0,44 | 4,46 | 0,59 |
| blit+tex-s5 | 2 | 5,41 | 0,68 | 5,45 | 0,70 | 6,72 | 0,76 |
| blit+tex-s9 | 2 | 10,29 | 0,98 | 10,23 | 0,96 | 9,43 | 0,89 |
| sgsr-repo | 1 | 5,86 | 0,83 | 6,05 | 0,86 | 3,74 | 0,59 |
| sgsr-src | 1 | 5,94 | 0,85 | 6,06 | 0,85 | 3,72 | 0,58 |
| nis | 1 | 265,79 | 30,77 | 246,27 | 27,80 | 155,98 | 17,80 |
| easu | 1 | 18,86 | 2,30 | 18,96 | 2,36 | 10,83 | 1,40 |
| rcas | 1 | 4,83 | 0,72 | 4,86 | 0,76 | 2,54 | 0,47 |
| fsr1 | 2 | 47,06 | 2,95 | 47,67 | 3,05 | 26,62 | 1,78 |
| blit+sgsr-repo | 2 | 11,34 | 1,01 | 11,58 | 1,09 | 9,54 | 0,91 |
| blit+fsr1 | 3 | 69,14 | 3,12 | 69,95 | 3,28 | 44,50 | 2,18 |

GPU p50 = somme des horodatages par passe (gonflée, gardée pour mémoire) ; mur/it = temps mur par
itération en ms, la borne. Second passage du cas ×2 texte ; le premier concorde à 12 % près sur la
somme GPU et à 18 % sur le mur, hors `chain-sgsr` (25 % et 39 % : deux régimes d'horloge, plus bas).

Chaîne du produit (`WebGpuRenderer` inchangé, un `draw()` par itération), ×2 texte, les deux
passages :

| cellule | passes | GPU p50 (passage 1) | GPU p50 (passage 2) | par passe (passage 2) | `draw()` CPU p50 | mur/it |
|---|---|---|---|---|---|---|
| chain-off | 1 | 0,79 | 0,85 | 0,85 | 2,12 | 2,34 |
| chain-sgsr | 2 | 1,35 | 1,80 | 0,23 / 1,63 | 2,42-2,78 | 4,11 |
| chain-nis | 2 | 29,85 | 31,15 | 0,26 / 30,85 | 31,6-32,9 | 32,88 |
| chain-fsr1 | 3 | 6,12 | 5,35 | 0,22 / 2,31 / 2,82 | 4,62-4,74 | 4,59 |

**Ce que l'iPhone dit** (bornes de temps mur à ×2 vers 1440p, GPU saturé) :

- **Plancher** : un tap bilinéaire sur `rgba8` vers 1440p ≤ 0,27 ms ; 5 taps ≤ 0,5 ; 9 taps
  ≤ 0,8 : 5 taps coûtent 1,8 × un tap, 9 taps 2,9 ×. Les taps ne sont pas gratuits ici,
  contrairement au RTX.
- **La texture externe coûte deux fois le tap RGBA** : `ext-s5` 0,92-0,94 contre `tex-s5`
  0,48-0,51, `ext-s9` 1,52-1,57 contre 0,80 (NV12 : deux plans lus par tap, comme dans Chrome). À
  un tap, l'écart tient dans le bruit (0,36-0,47 contre 0,27-0,28).
- **Passe 0** : ≤ 0,24 ms à 720p. `blit+tex-s1` 0,44 ≈ `ext-s1` 0,36-0,47 (égalité) ; `blit+tex-s5`
  0,68-0,70 contre `ext-s5` 0,92-0,94 (−25 %) ; `blit+tex-s9` 0,96-0,98 contre 1,52-1,57
  (−38 %). Le point d'équilibre à ×2 est vers **2 à 3 taps par pixel en moyenne** ; à ×0,75 (passe
  0 à 1440p ≈ 0,5 ms) la lecture directe garde l'avantage jusqu'à 8-9 taps (`blit+tex-s9` 0,89
  contre `ext-s9` 0,98 ; à 1 et 5 taps les cellules légères de ce cas sont posées sur son plancher
  de soumission, ≈ 0,45 ms, et ne se séparent pas).
- **`fwidth`** : dans le bruit (−20 % à +19 % selon le feed et l'image, soit ≤ 0,05 ms) : bon
  marché, comme sur NVIDIA.
- **`textureLoad` sur l'externe** : +5 % à 5 taps, dans le bruit à 1 : comme sur AMD, pas
  d'intérêt, `DERING_EXACT` par échantillons.
- **Lignes de base saturées** : SGSR1 0,83-0,86 ms (3 × le bilinéaire), EASU 2,3, RCAS 0,7, FSR1
  2,95-3,05 (11 ×), NIS 27,8-30,8 ms (**100 × le bilinéaire** : ce port est hors d'usage sur
  Apple, où le 780M le paie 28 × et le RTX 16 × ; un tableau indexé dynamiquement ou une boucle
  que le compilateur Metal déroule en mémoire est le suspect habituel, à regarder hors de P0, le
  produit propose NIS sur iPhone). Chaîne du produit, à la cadence du labo (une image toutes les
  2 à 5 ms) : bilinéaire 0,8 ms de GPU + 2,1 ms de CPU par image, SGSR1 1,35-1,8 + 2,4-2,8, FSR1
  5,4-6,1 + 4,6-4,7, NIS 30-31 ms.
- **Le régime d'horloge compte plus que sur ordinateur** : la même passe coûte 1,5 à 3 × plus en
  soumissions espacées (chaîne, premier tour, cas ×0,75 plus léger) qu'au milieu d'un lot saturé.
  Les comparaisons A/B restent valides parce que le labo entrelace les cellules (ABBA) dans le
  même régime ; les **budgets absolus** d'un téléphone doivent se lire à la cadence du produit
  (60 i/s, décodage compris) : une cadence `tick` pour les cellules `chain-*` manque au labo.
- **La soumission** : `draw()` du renderer coûte 2,1 ms de CPU par image sur l'A15 (import,
  bind group, encodage), un quart d'un budget 120 Hz : P1 (contournement 1:1) a son intérêt sur
  le téléphone aussi.

**Ce que cela change au plan.** La décision n° 2 (pas de passe 0 en SDR) **tient pour le noyau
prévu** (un tap sur le plat, cinq sur les contours : 1,4 à 2,2 taps par pixel en moyenne, sous le
point d'équilibre à ×2 et loin dessous en réduction) ; l'`override` « passe 0 » du §3.4 reste un
bouton par plateforme, et P2 mesurera le noyau réel des deux côtés sur l'iPhone. `subgroups` est
absent de WebKit : les accélérations par sous-groupes sont une option d'ordinateur, la base du
noyau n'en dépend pas. `adapter.info` est vide sur iOS : le client ne peut choisir que sur
`features` et `limits`. La cible C1 « plus rapide que SGSR1 sur mobile » vaut ici **≤ 0,8 ms
saturé à 1440p** (≈ 3 × le bilinéaire), avec FSR1 à 3 ms, et le port NIS exclu de la comparaison.

## 4 quater. Mac M1 Pro (Apple `metal-3`, Chrome), 21/10 au matin

Créneau de Bruno de 30 min sur le Mac de Léo (session verrouillée, secteur ; Roblox en barre de
menus, laissé), labo servi depuis DualRTX et atteint par un tunnel SSH inverse sur le `127.0.0.1`
du Mac (aucune règle de pare-feu), Chrome du Mac en instance dédiée (`--user-data-dir` jetable,
`--mute-audio`), avertissement pour Léo par une boîte osascript dans sa session. Neuf cas en deux
minutes de page : les cellules de P0 plus le noyau `mwsr` de P2.1 (sa première table, `DERING 1`),
en `-single` (une soumission par itération, les horodatages par passe lisibles sur ce GPU à tuiles,
mais **quantifiés à 65,5 µs**) et en lot (`back` : le temps mur par itération sous contre-pression,
la borne haute du coût réel ; les horodatages d'un lot ne s'additionnent pas, §4 ter).

| cellule (×2, 720p → 1440p) | `text`, GPU `-single` | `text`, mur/it `back` | `game`, GPU `-single` | `game`, mur/it `back` | `text` ×1,33 GPU | `game` ×1,33 GPU | `text` ×0,75 GPU |
|---|---|---|---|---|---|---|---|
| `blit` (passe 0) | 0,066 | 0,156 | 0,066 | 0,172 | 0,131 | 0,131 | 0,131 |
| `tex-s1` (le plancher) | 0,131 | 0,127 | 0,131 | 0,133 | 0,131 | 0,131 | 0,066 |
| `tex-s5` / `tex-s9` | 0,262 / 0,524 | 0,221 / 0,357 | 0,197 / 0,262 | 0,226 / 0,360 | 0,197 / 0,262 | 0,197 / 0,262 | 0,131 / 0,197 |
| `ext-s1` / `ext-s5` | 0,262 / 0,786 | 0,195 / 0,540 | 0,131 / 0,393 | 0,139 / 0,489 | 0,131 / 0,393 | 0,131 / 0,393 | 0,066 / 0,262 |
| **`mwsr`** (noyau seul) | **0,393** | **0,262** | **0,131** | **0,154** | **0,197** | **0,197** | **0,131** |
| `mwsr:dering=0` | 0,328 | 0,210 | 0,131 | 0,136 | 0,131 | 0,131 | 0,066 |
| `mwsr:early=0` | 0,590 | 0,420 | 0,328 | 0,415 | 0,328 | 0,328 | 0,197 |
| **`ext-mwsr`** (chaîne SDR sans passe 0) | 0,786 | 0,613 | 0,197 | 0,231 | 0,459 | 0,393 | 0,328 |
| `ext-mwsr:dering=0` | 0,590 | 0,405 | 0,131 | 0,190 | 0,328 | 0,262 | 0,197 |
| `sgsr-repo` | 0,459 | 0,366 | 0,328 | 0,367 | 0,262 | 0,328 | 0,197 |
| `fsr1` (EASU + RCAS) | 1,769 | 1,274 | 1,769 | 1,192 | 1,769 | 1,835 | 1,049 |
| `nis` | 2,032 | 2,626 | 1,901 | 2,390 | 2,097 | 1,966 | 1,180 |
| `blit+sgsr-repo` / `blit+fsr1` (chaînes livrées) | 0,524 / 2,621 | 0,395 / 1,297 | 0,393 / 1,835 | 0,442 / 1,293 | 0,459 / 1,901 | 0,524 / 1,901 | 0,393 / 1,311 |

Chaîne du produit à **1:1** (2560×1440, `WebGpuRenderer` inchangé, P1) : `chain-sgsr`, `chain-nis`,
`chain-fsr1` font une passe, 48 copies sur 48, 0,197-0,262 ms de GPU comme `chain-off` (0,262) ; le
`draw()` coûte 1,3-1,5 ms de mur par image, dont ≈ 1,1 ms de soumission : **C7 tenue sur le M1**. À
×2 (`x2-chain`), `draw()` vaut 1,28 ms pour `off`, 1,56 pour SGSR1, 2,04 pour FSR1, 3,1 pour NIS.

**Ce que le M1 dit.**

- **Lignes de base, noyau seul à ×2 vers 1440p** (mur sous contre-pression / GPU `-single`) :
  bilinéaire 0,13 / 0,13 ; SGSR1 0,37 / 0,46 ; FSR1 1,27 / 1,77 ; NIS 2,6 / 2,0 — NIS n'a pas ici la
  pathologie de l'iPhone (×15 le plancher, pas ×100 ; à revoir sur l'A15 en `-single`).
- **`mwsr`** : 0,26 / 0,39 ms sur `text`, 0,15 / 0,13 sur `game` (au plancher). Contre SGSR1 : × 0,72-0,86
  sur le texte, × 0,40-0,42 sur `game` ; contre FSR1 : × 0,21 et × 0,07-0,13. **C1 provisoirement tenue
  sur Apple** (« ≤ 0,8 × SGSR1 sur jeu et interface, ≤ 1,0 × sur texte dense, noyau seul ≤ 0,9 × »).
- **La sortie anticipée paie aussi sur Apple** : sans elle, 0,42 ms partout (= `tex-s9`), soit +60 % sur
  le texte et ×2,7 sur `game` ; le conseil « souvent il faut juste essayer » ne vaut pas pour ce noyau.
- **La borne exacte** coûte un quantum (0,05-0,065 ms) sur le texte, rien ailleurs.
- **La texture externe coûte cher sur Apple** (deux plans par échantillon, §4 ter) : `ext-mwsr`
  0,61 ms sur `text` contre `blit` + `mwsr` ≈ 0,42, et 0,46 contre 0,33 à ×1,33 ; sur `game`, 0,23 contre
  0,32 (l'externe gagne quand les contours sont rares). La décision n° 2 (pas de passe 0) est donc
  **par plateforme et par contenu** : l'`override` « passe 0 » du §3.4 doit être **actif sur Apple** par
  défaut, à moins que P2.3 ne ramène la borne par échantillons et le coût des contours sous le prix
  de la passe 0 (0,16 ms à 720p).
- Les écarts tour à tour sont larges sur les cellules sous 0,3 ms (quantification 65,5 µs et Roblox
  en barre de menus) : lire les rapports entre cellules, pas les absolus au centième.

## 4 quinquies. realme Note 60 (Mali-G57 MP1, Chrome Android), 21/10 après-midi

Créneau de Bruno de cinq minutes (14:26-14:31), la page servie depuis DualRTX comme pour l'iPhone
(huit liens ; aucune règle de pare-feu à ouvrir, les règles entrantes « Python » existantes couvrent
le port). Adaptateur `arm valhall` ; `shader-f16`, `timestamp-query`, `subgroups`,
`float32-filterable` présents ; décodeur H.264 matériel à **sortie RGBA** (un échantillon de la texture
externe vaut un échantillon RGBA : `ext-s1` = `tex-s1`). **Les horodatages d'un lot s'additionnent**
sur ce GPU (lot 18,0 ms contre 18,6 à une soumission par itération) ; dispersion ≤ 2 % hors cellules
sous 2 ms. Détail et réductions au journal J16. GPU p50 en ms :

| cas | plancher | SGSR1 | FSR1 | **`mwsr`** | `half=1` | `dering=0` | passe 0 + `mwsr` |
|---|---|---|---|---|---|---|---|
| ×2 texte, 720p → 1440p | 3,60 | 24,5 | 83,1 | **18,0** | 16,3 | 13,2 | 18,8 |
| ×2 jeu | 3,67 | 23,3 | 83,1 | **8,78** | 7,60 | 7,41 | 9,90 |
| ×1,33 texte | 3,60 | 22,5 | 83,2 | **16,7** | 14,9 | 12,3 | |
| l'écran du realme, texte, 720p → 1600×720 | 1,18 | 8,39 | 26,0 | **5,90** | 5,31 | 4,33 | 6,75 |

Chaînes du produit à ×2 (une image par tampon) : `off` 4,0 ms de GPU pour 22 ms de mur par `draw()`,
SGSR1 26,3 / 47, FSR1 85 / 110 : le chemin CPU du renderer pèse 18 ms sur ce SoC, à regarder en P5.

**Ce que le realme dit.** C1 tenue sur Mali : noyau seul 0,74 × SGSR1 sur le texte, 0,38 × sur le
jeu (critère ≤ 0,9 ; ≤ 0,8 jeu, ≤ 1,0 texte), 0,66 / 0,33 avec `half` ; à la taille de l'écran, passe
0 + `mwsr` = 6,75 ms par image (SGSR1 9,6, FSR1 27 : les enhancers livrés font tomber des images sur
ce téléphone). `half` −10 % (comme sur le 780M), `dering=0` −27 % sur le texte. La passe 0 coûte
0,85-0,92 ms là où l'externe est déjà RGBA : `ext-mwsr` reste à mesurer (un lien), décision P4 par le
format du décodeur. Réduction : l'échantillon unique à travers les vues sRGB coûte le plancher
(1,18 ms à ×0,67, 0,98 à ×0,5), la grille 2×2 3,2 fois plus : C10 tenu en coût sur sa machine (P3 §6).

## 5. Réponses de P0 et porte

| Question (§6.4) | Réponse | Démontré / attendu |
|---|---|---|
| Externe contre passe 0 + RGBA | **Pas de passe 0 en SDR** (décision n° 2 confirmée). RTX : égalité ; 780M : la lecture directe gagne dès que l'entrée dépasse 720p ou que le noyau lit un tap sur le plat, et perd 5-7 % seulement sur du texte dense à ×2 avec cinq taps partout. iPhone 13 Pro : un tap sur l'externe vaut deux taps RGBA, la passe 0 (≤ 0,24 ms à 720p) ne gagne qu'au-delà de 2-3 taps par pixel à ×2 et de 8 en réduction : la décision tient pour le noyau prévu, l'`override` passe 0 reste un bouton par plateforme. Le feed `texture_2d` reste dans la même source (HDR, labo, repli). | démontré sur deux GPU d'ordinateur et sur l'iPhone 13 Pro (§4 ter) ; realme à mesurer |
| Coût des dérivées | gratuit sur NVIDIA, ≈ un deuxième échantillon sur l'iGPU AMD (+0,08 ms à 1440p), toujours bien moins qu'un gather | démontré |
| Dispersion | ≤ 1,7 % (RTX) et ≤ 2,6 % (780M) tour à tour en `back` ; porte « < 5 % » tenue. Horodatages à la nanoseconde avec le drapeau développeur. En `tick`, bruit sur les cellules externes du RTX (p99 × 30) : les mesures de P2 se font en `back`, et le régime `tick` sert à vérifier la chaîne, pas le noyau. iPhone : les horodatages d'un lot ne s'additionnent pas (§4 ter) ; temps mur et chaîne comme lectures, cas `-single` au prochain créneau | démontré sur ordinateur ; lecture adaptée sur Apple |
| Lignes de base | RTX : SGSR1 0,07, FSR1 0,25, NIS 0,44 ms (chaîne 0,09 / 0,26 / 0,45) ; 780M : SGSR1 2,5, FSR1 9,4, NIS 10,5 ms (chaîne 2,8 / 9,5 / 10,9), plancher bilinéaire 0,028 et 0,38 ms ; iPhone 13 Pro, saturé : SGSR1 0,85, FSR1 3,0, NIS 28-31 ms, plancher 0,27 (chaîne du produit : 1,35-1,8 / 5,4-6,1 / 30-31 ms) ; **Mac M1 Pro** (§4 quater), saturé : SGSR1 0,37, FSR1 1,27, NIS 2,6 ms, plancher 0,13 (chaînes livrées 0,40 / 1,30 ; `draw()` 1,3-2 ms) | démontré |

**Ce que ces chiffres changent au plan.**

- Les critères C2 (« chaîne WebGPU ≤ 0,6 × FSR1 ») sont **larges** sur ordinateur : un noyau à
  1 + 4 taps coûte 0,47-1,3 ms sur le 780M contre 9,4 pour FSR1 et 2,5 pour SGSR1. La question
  de P2 n'est pas la vitesse sur ordinateur, c'est la **qualité à FSR1** (C3) et la vitesse sur
  les téléphones (C1 : sur l'A15, ≤ 0,8 ms saturé à 1440p, §4 ter).
- Sur le RTX, et à 60 i/s sur les deux GPU, le coût qui compte est la **soumission** (3,3-4,2 ms
  de temps mur pour 0,03-0,5 ms de GPU) : P1 (contournement 1:1) et la porte P4 (WebGPU contre
  WebGL2) portent sur ce coût-là, pas sur le shader. Rien ne change à leur contenu.
- Le vote par dérivées coûte un demi-échantillon sur AMD : la variante `EARLY_OUT` « cinq
  échantillons d'emblée, branche sur l'arithmétique » (§3.2) a une raison de plus d'être mesurée
  en P2.
- `DERING_EXACT` par `textureLoad` sur l'externe est écarté sur ce feed ; par échantillons
  seulement.

**Porte P0** : tenue pour l'ordinateur (dispersion < 5 %, coût de l'externe connu, décision passe
0 prise), et tenue sur l'iPhone 13 Pro pour le noyau prévu. Il manque le realme Note 60 et le Mac,
qui ne bloquent pas P1 ni P2.1 (labo sur DualRTX) mais entrent avant la porte P2. *[Mac fait le 21/10
(§4 quater), realme fait le 21/10 (§4 quinquies) : la porte P0 est complète, C1 tenue sur Apple et sur
Mali.]*

## 6. Ce qui reste de P0

- ~~Le Mac~~ (fait le 21/10, §4 quater, par tunnel SSH inverse : plus besoin de règle de pare-feu quand
  la machine a SSH). ~~Le realme Note 60~~ (fait le 21/10, §4 quinquies, journal J16 ; reste `ext-mwsr`
  sur lui, un lien). Un second passage de l'iPhone avec les cas
  `-single` (liens `/4` à `/6`) : même procédure (`scaler_lab.py --serve 0.0.0.0:8766`, règle de
  pare-feu ouverte pour le créneau et retirée après, résultat en
  `bench-out/scaler-lab/phone-*.json`). `mw-arm` en WebGL2 seulement (pas de WebGPU sur l'Adreno
  618).
- ~~Une cadence `tick` (60 i/s) pour les cellules `chain-*`~~ : faite le 20/10 (`875c956a`, le
  labo de P1 ; `runChain` honore `pace=tick`), le prochain passage iPhone avec les cas `-single`
  en profite (§4 ter).
- FLIP : une roue `flip-evaluator` pour Python 3.14 (ou une réécriture numpy du LDR-FLIP),
  avant les verdicts C3/C4 de P2.
- La version compressée des images (boucle WebCodecs → `dump` sur le feed externe) dans la
  chaîne de qualité, et la mire PQ (P3).
- La mire `code` a son tiers central vide (PSNR infini au centre) : décaler le texte pour que le
  centre porte du contenu.
- Le port NIS sur Apple (100 × le bilinéaire, §4 ter) : hors P0, à regarder avant de le proposer
  sur iPhone.
