# Upscaler `mwsr` — rapport de la phase P2 (le noyau)

> Phase P2 du plan `upscaler-mwsr.md` (§3, §6, §9). Ce rapport suit les sous-phases : **P2.1**, le
> noyau de base et sa première table (21/10/2026, Fable 5.1 `max` par décision D4), puis P2.2 (la
> boucle), P2.3 (les couches), P2.4 (l'expérience compute). Le détail des essais est dans
> `scripts/bench/scaler-lab/journal.md` (J1 à J4) ; ici, ce qui en sort.

## 1. P2.1 — le noyau de base et sa première table

### 1.1 Le texte (`frontend/js/stream/renderers/MwsrShader.js`, commits `fa42a66c`, `8e9a5903`)

Une source WGSL, spécialisée par constantes `override`, le feed substitué dans le préambule
(`texture_2d<f32>` : chemins HDR et labo ; `texture_external` : SDR sans passe 0). Le vertex est le
triangle plein écran habituel ; le fragment, par pixel de sortie :

1. **Un échantillon bilinéaire** `C` à la position du pixel dans l'entrée, sa luma
   (`0,25 R + 0,625 G + 0,125 B`, Rec. 709 arrondie aux puissances de deux).
2. **Le vote** : les dérivées d'écran grossières de cette luma (`dpdxCoarse`, `dpdyCoarse`), ramenées
   en luma par texel d'entrée (× l'échelle), comparées à `τ` ; le quad entier prend la même branche.
   Un quad plat retourne `C` : une passe, un échantillon, une dizaine d'opérations. Les dérivées
   sont prises avant la branche, en flot de contrôle uniforme, comme WGSL l'exige ; après elle, les
   échantillons sont à niveau explicite (`textureSampleLevel`, `textureSampleBaseClampToEdge`).
3. **Sur un contour**, quatre échantillons bilinéaires de plus, dans le repère que donnent les
   dérivées (`ORIENT 1` ; `ORIENT 0` = la croix sur les axes, gardée pour le labo) : deux **le long**
   du contour à `R_ALONG` texels (poids `W_ALONG · a`, un lissage), deux **en travers** à `R_ACROSS`
   texels (poids `−W_ACROSS · netteté · a`, borné à `W_MIN` : une accentuation). `a` est la
   **cohérence** : `max(marche, crête) / variation` où marche = `|X2 − X1|`, crête =
   `|X1 + X2 − 2C|`, variation = la somme des quatre écarts de luma à `C` ; 1 sur un contour ou un
   trait net, vers 0 sur une texture, un grain ou un bloc de compression. Multipliée par la force
   (0 à 1:1, 1 dès `S_FULL`), de sorte que le noyau tend vers le bilinéaire quand le
   contournement 1:1 (P1) prend le relais.
4. **La borne.** Le mélange est borné par le min et le max des cinq échantillons, puis, `DERING 1`,
   par les **quatre texels d'entrée autour du pixel** (quatre `textureLoad` sur les quads de contour
   seulement) : l'empreinte exacte du bilinéaire, donc aucun pixel hors de sa plage locale.

Ce que le texte ne fait pas (plan §3.4) : pas de `textureGather`, pas de `discard`, pas de boucle,
pas d'indexation dynamique, pas de lecture dépendante du contenu (les positions viennent de `p` et
des dérivées). Le fichier porte les idées empruntées et leur source (taps bilinéaires, sortie
anticipée sur un vote, borne locale, netteté tenue par la plage), et le test
(`frontend/test/MwsrShader.test.js`) vérifie qu'aucune constante des noyaux voisins n'y entre.

### 1.2 La méthode

Qualité sur SwiftShader (mêmes pixels que le RTX au centième de dB, P0 §4 bis), par `--quality`
et `--quality-cells` : chaque variante est une cellule `mwsr:clé=valeur;…`, rendue sur la même entrée
(vérité réduite en Lanczos-3 linéaire) et mesurée contre la vérité (PSNR, SSIM, dépassements hors de
l'empreinte 2×2 ; FLIP attend une roue Python 3.14). Cinq images à ×2 (720p → 1440p) : `text`,
`code`, `game`, `zone`, l'étalon de Bruno ; deux à ×1,33 (1080p → 1440p) : l'étalon et `text`.
Quatre tours (J1 à J4, journal) : le noyau tel qu'écrit, le balayage des poids, le dosage et la
borne exacte, une courbe bornée sur les marches (rejetée). Temps GPU sur le RTX 5060 Ti ensuite
(§1.4).

### 1.3 La table, et la qualité contre les références

**Première table** : `ORIENT 1`, `W_ALONG 0,15`, `R_ALONG 0,5`, `W_ACROSS 0,35`, `R_ACROSS 1`,
`W_MIN −0,3`, `DERING 1`, `S_FULL 1,5`, `τ 0,05`, netteté 1.

Ce que les quatre tours ont appris :

- le **lissage le long du contour à ±1 texel coûte partout** (−0,5 dB sur `text`, −0,9 dB au centre
  de l'étalon) : à ×2 les glyphes de 12 px n'ont que des courbes et des extrémités ; à un
  **demi-texel**, il rend +0,4 dB au centre de l'étalon et divise les dépassements par deux ;
- ce qui paie est l'**accentuation directionnelle en travers** de la rampe bilinéaire : le texte en
  voudrait plus (`W_MIN −0,4` : +0,25 dB sur `text` droit avec les axes), les photos moins
  (−1,6 dB au centre de l'étalon à cette force) ; `W_ACROSS 0,35` borné à `−0,3` est le milieu, et la
  netteté (uniforme) déplace le point sans recompiler ;
- la **borne exacte 2×2** met les dépassements à **0 % sur toutes les images** sans bouger PSNR ni
  SSIM d'un centième : le critère C3 « dépassements ≤ FSR1 » est acquis par construction ;
- le repère des dérivées bat les axes sur du contenu naturel (+0,5 dB sur l'étalon à force égale)
  et perd 0,25 dB sur du texte droit : il reste la base ;
- `τ` entre 0,02 et 0,08, `R_ACROSS` < 1, la courbe bornée (`SHAPE`) : rien à gagner.

| image | bilinéaire | SGSR1 (dépôt) | FSR1 | **mwsr, table** |
|---|---|---|---|---|
| `text` ×2 | 16,99 / 0,816 / 0 % | 18,13 / 0,869 / 4,4 % | 17,57 / 0,845 / 0,3 % | **17,42 / 0,842 / 0 %** |
| `code` ×2 | 29,98 / 0,977 / 0 % | 29,65 / 0,974 / 2,6 % | 30,36 / 0,975 / 0,7 % | **29,89 / 0,978 / 0 %** |
| `game` ×2 | 35,01 / 0,880 / 0 % | 35,61 / 0,883 / 0,7 % | 35,55 / 0,887 / 0,03 % | **35,87 / 0,882 / 0 %** |
| `zone` ×2 | 10,41 / 0,423 / 0 % | 10,80 / 0,491 / 0 % | 10,79 / 0,484 / 3,4 % | **10,65 / 0,459 / 0 %** |
| étalon ×2, tiers central | 31,56 / 0,928 | 31,28 / 0,930 (6,8 %) | 32,26 / 0,940 (2,0 %) | **31,82 / 0,933 (0 %)** |
| étalon ×1,33, tiers central | 36,36 / 0,977 | 34,55 / 0,970 (5,0 %) | 35,94 / 0,976 (5,0 %) | **36,55 / 0,978 (0 %)** |
| `text` ×1,33 | 20,52 / 0,923 / 0 % | 21,64 / 0,946 / 2,7 % | 21,45 / 0,942 / 0,2 % | **21,60 / 0,944 / 0 %** |

PSNR / SSIM / dépassements (entre parenthèses : dépassements de l'image entière). Lecture contre
le critère C3 (« FLIP ≤ FSR1 + 0,01, SSIM ≥ FSR1 − 0,005, dépassements ≤ FSR1 ») :

- **à ×1,33, `mwsr` est au-dessus de FSR1** partout (+0,6 dB au centre de l'étalon, +0,15 dB sur le
  texte, SSIM +0,002), là où RCAS, réglé pour ×2, sort 5 % des pixels de leur plage ;
- **à ×2, `mwsr` vaut FSR1 à 0,15-0,45 dB près** en PSNR (au-dessus sur `game`, +0,32 dB), et en SSIM
  dans −0,007…+0,003 : l'étalon (−0,007) et `game` (−0,005) sont au bord du critère, le texte
  (−0,003) et `code` (+0,003) dedans. Ce qui manque à ×2 est de la **reconstruction** (EASU
  interpole douze texels dans une fenêtre tournée ; un masque flou directionnel n'en fait pas), pas de
  la netteté ni de la propreté : c'est la question de P2.2 et de `TIER` qualité (quatre diagonales) ;
- **les dépassements sont à 0 %** sur toutes les images, contre 0,03-5 % pour FSR1 et 0,7-6,8 % pour
  SGSR1 : sur les serifs et les contours de l'étalon, aucune sonnerie, par construction ;
- SGSR1 garde le meilleur PSNR sur le texte brut (18,13) en payant 4,4 % de dépassements, et passe
  sous le bilinéaire sur l'étalon : la règle de P0 tient (FSR1 est la référence à égaler, SGSR1 celle
  à battre sur la sonnerie, et `mwsr` la bat).

### 1.4 Le temps GPU (RTX 5060 Ti, `scaler_lab.py --p2`)

Passe du 21/10 au matin (Chrome 155 sans tête, `--enable-webgpu-developer-features`, adaptateur
épinglé, 3 tours entrelacés × 8 lots de 16 itérations, dispersion ≤ 1,8 % sauf FSR1 sur `game`
10 %). Temps GPU p50 en ms d'une passe vers 2560×1440 ; `tex-*` = noyau seul sur `rgba8` ; `ext-*`
= la chaîne telle qu'elle serait livrée en SDR, sans passe 0, sur la texture externe NV12 du
décodeur ; FSR1 = EASU → intermédiaire → RCAS (deux passes, sans sa passe 0 : +0,01 ms).

| cellule | `text` ×2 | `ui` ×2 | `game` ×2 | `text` ×1,33 | `game` ×1,33 |
|---|---|---|---|---|---|
| `tex-s1` (le plancher : une passe, un bilinéaire) | 0,028 | 0,028 | 0,028 | 0,028 | 0,028 |
| `tex-s5` / `tex-s9` (5 / 9 bilinéaires partout) | 0,047 / 0,085 | 0,047 / 0,085 | 0,047 / 0,085 | 0,047 / 0,085 | 0,047 / 0,085 |
| **`mwsr`** (la table, `DERING 1`) | **0,051** | **0,029** | **0,028** | **0,046** | **0,036** |
| `mwsr:dering=0` | 0,039 | 0,028 | 0,028 | 0,036 | 0,031 |
| `mwsr:early=0` (sans la sortie anticipée) | 0,086 | 0,085 | 0,086 | 0,086 | 0,085 |
| `mwsr:orient=0` (la croix sur les axes) | 0,052 | 0,029 | 0,028 | 0,046 | 0,037 |
| `ext-s1` / `ext-s5` | 0,028 / 0,057 | 0,028 / 0,057 | 0,028 / 0,057 | 0,030 / 0,066 | 0,029 / 0,060 |
| **`ext-mwsr`** (la chaîne SDR sans passe 0) | **0,096** | **0,048** | **0,043** | **0,088** | **0,067** |
| `ext-mwsr:dering=0` | 0,065 | 0,036 | 0,033 | 0,062 | 0,048 |
| `sgsr-repo` (noyau seul) | 0,073 | 0,039 | 0,066 | 0,066 | 0,065 |
| `fsr1` (EASU + RCAS) | 0,247 | 0,246 | 0,246 | 0,247 | 0,246 |
| `nis` | 0,441 | 0,310 | 0,421 | 0,510 | 0,551 |

**Lecture.**

1. **Le noyau est au plancher hors du texte** : 0,028-0,029 ms sur `game` et `ui`, le prix d'une
   passe à un bilinéaire. Le grain de `game`, qui déclenche le vote de SGSR1 partout (0,066), passe
   sous `τ` (0,05 de luma par texel) : la sortie anticipée fait son travail. Sur `text` (environ
   quatre quads sur dix sur le chemin contour, à lire par la règle de trois entre `tex-s1` et
   `tex-s9`), 0,051 ms.
2. **Contre les références, noyau seul** : SGSR1 × 0,42-0,74 (C1 « ≤ 0,9 » tenu ici ; le mobile
   dira), FSR1 × 0,11-0,21, NIS × 0,06-0,12. **Chaîne SDR** : `ext-mwsr` 0,043-0,096 ms contre
   ≈ 0,26 pour passe 0 + FSR1 et ≈ 0,09 pour passe 0 + SGSR1 (P0) : C2 « ≤ 0,6 × FSR1 » tenu avec
   marge (× 0,17-0,37).
3. **La sortie anticipée vaut 40-67 % sur ce GPU** : sans elle, 0,086 partout, le coût de neuf
   fetches par pixel (`tex-s9`). Le conseil d'Apple (« souvent il faut juste essayer ») est à
   remesurer sur l'A15 ; sur NVIDIA la branche gagne.
4. **La borne exacte coûte 0,01 ms sur le texte** (quatre `textureLoad` sur les quads de contour),
   rien ailleurs ; sur la **texture externe** elle coûte 0,03 ms (`textureLoad` externe = deux plans
   et une conversion par texel, comme P0 l'a vu) : P2.3 la fera par quatre échantillons au plus
   proche sur ce feed, ou la réservera au `TIER` qualité.
5. **La texture externe** ajoute 0,01-0,045 ms au noyau selon la part de contours (deux fetches par
   échantillon) ; c'est le prix de l'absence de passe 0, qui en économise 0,01-0,45 selon le GPU
   (P0) : la décision n° 2 tient sur le RTX ; le 780M et les téléphones la rejugent en P2.3.
6. Les axes (`ORIENT 0`) coûtent la même chose que le repère des dérivées : le choix s'est fait sur
   la qualité seule (§1.3).

**Mac M1 Pro, le même matin** (créneau de Bruno, rapport P0 §4 quater pour le tableau complet) :
noyau seul à ×2 vers 1440p, temps mur par itération sous contre-pression, `mwsr` **0,26 ms sur
`text`, 0,15 sur `game`** (plancher 0,13 ; SGSR1 0,37 ; FSR1 1,27 ; NIS 2,6) : × 0,72 et × 0,42 de
SGSR1, **C1 provisoirement tenue sur Apple**. La sortie anticipée y vaut +60 % sur le texte et
× 2,7 sur `game` ; la borne exacte un quantum de 65 µs. Mais **la texture externe y coûte** :
`ext-mwsr` 0,61 ms sur `text` contre `blit` + noyau ≈ 0,42 — sur Apple la passe 0 reste le bon
chemin tant que les contours sont nombreux, et l'`override` « passe 0 » (§3.4) devient un vrai choix
par plateforme pour P2.3.

### 1.5 Ce que P2.1 laisse à P2.2 et P2.3

- **P2.2** : la reconstruction à ×2 (SSIM) — `TIER` qualité avec les quatre diagonales et une
  fenêtre tournée sur neuf échantillons, le poids de la luma dans la borne, FLIP dès qu'il tourne ;
  la part des quads de contour par image (`SHOW 1` et un comptage hors ligne) ; `malioc` sur le GLSL
  du jumeau ; les constantes de l'échelle (`S_FULL`) sur ×1,5 et ×3.
- **P2.3** : le feed externe (`ext-mwsr`) et le coût de `DERING 1` par `textureLoad` sur une texture
  externe (P0 : plus cher que l'échantillon sur AMD et Apple → variante par échantillons au plus
  proche), `HALF`, `QUAD_UNIFORM`, `EARLY_OUT 0` contre 1 par classe de GPU.
- À nettoyer en fin de P2.2 : `SHAPE`/`K_SHAPE` (rejetés, J4) et `ORIENT 0` si rien ne les rappelle.

## 2. P2.2 — la boucle d'optimisation (21/10/2026)

### 2.1 L'instrument, complété

- **FLIP** : `flip-evaluator` n'a pas de roue pour Python 3.14 ; `metrics.py` l'appelle désormais
  dans un venv Python 3.12 posé à côté du labo (`.flipenv`, ignoré par git, ou `MW_FLIP_PYTHON`),
  les deux images passées en `.npy`. Les colonnes FLIP et FLIP p99 de `--quality` se remplissent ;
  les verdicts de C3 se lisent en FLIP (plus bas = mieux).
- **La part du chemin contour** : une cellule `mwsr:show=1` peint le vote et le pilote imprime la
  part des pixels traités : `text` 35 %, étalon 29 %, `game` 2 %, `zone` 50 %, `code` 14 % à ×2 ;
  26-28 % à ×1,33 ; 37-40 % à ×3.
- La mire `code` est passée à deux colonnes (son tiers central était vide, P0 §6) ; ses chiffres
  depuis J5 ne se comparent plus à ceux de J1-J4.

### 2.2 Les quatre tours (journal J5 à J8)

| tour | hypothèse | verdict |
|---|---|---|
| J5 | les quatre coins de la grille 3×3 tournée (`TIER 1`, neuf échantillons, fenêtre séparable) rendent la reconstruction qui manque à ×2 | **rejetée** : +0,2-0,4 dB sur le texte mais −0,7 dB au centre de l'étalon, et le **FLIP** les refuse partout (texte 0,073-0,076 contre 0,072 ; étalon 0,056-0,059 contre 0,052) |
| J6 | les 71 % de pixels de l'étalon sous `τ`, rendus en bilinéaire pur, portent l'écart de SSIM ; `τ` de 0,05 à 0 le referme | **rejetée** : traiter tous les pixels rend 0,001 de FLIP et 0,003 de SSIM pour deux fois plus de quads traités ; l'écart tient à ce que le noyau fait sur les contours |
| J7 | le rayon en travers (0,75-0,85) et la force referment l'écart | **rejetée** (FLIP plat à ± 0,002) ; un gain gratuit : `W_ACROSS 0,3` (+0,13 dB au centre de l'étalon, FLIP égal ou meilleur partout) |
| J8 | `S_FULL` à ×1,33 ; contrôle à ×3 | `S_FULL 1,5` reste (meilleur FLIP sur l'étalon) ; à ×3 le noyau vaut FSR1 (FLIP 0,076 / 0,073 sur l'étalon, 0,111 / 0,111 sur le texte) sans réglage propre |

Trois tours sur la question de l'étalon à ×2 (règle du §8.3) : l'écart de FLIP qui reste (0,051
contre 0,045) est celui d'une reconstruction à cinq échantillons contre douze texels, pas d'un
réglage ; il entre dans C3 (≤ +0,01) et on s'arrête là. Les variantes rejetées (`ORIENT 0`, `SHAPE`,
`TIER`) sont **retirées du texte** : le WGSL ne porte que ce qui tourne (plan §3.6).

### 2.3 La table de P2.2 et C3

`W_ALONG 0,15`, `R_ALONG 0,5`, `W_ACROSS 0,3`, `R_ACROSS 1`, `W_MIN −0,3`, `DERING 1`, `S_FULL 1,5`,
`EARLY_OUT 1`, luma `(0,25, 0,625, 0,125)`, `τ 0,05`, netteté 1.

| cas | FLIP FSR1 | **FLIP mwsr** | écart (≤ +0,010) | SSIM mwsr − FSR1 (≥ −0,005) | dépassements |
|---|---|---|---|---|---|
| `text` ×2 | 0,068 | **0,071** | +0,003 | −0,003 | 0 % |
| étalon ×2 (image entière) | 0,045 | **0,051** | +0,006 | −0,006 (centre) | 0 % |
| `game` ×2 | 0,017 | **0,019** | +0,002 | −0,005 | 0 % |
| `zone` ×2 | 0,107 | **0,116** | +0,009 | −0,025 | 0 % |
| `code` ×2 | 0,024 | **0,029** | +0,005 | +0,005 | 0 % |
| étalon ×1,33 | 0,035 | **0,038** | +0,003 | +0,003 (centre) | 0 % |
| `text` ×1,33 | 0,042 | **0,047** | +0,005 | +0,000 | 0 % |
| étalon ×3 | 0,073 | **0,076** | +0,003 | +0,002 (centre) | 0,4 % (bords) |
| `text` ×3 | 0,111 | **0,111** | 0 | −0,003 | 0,3 % (bords) |

**C3 tenu en FLIP et en dépassements sur les neuf cas** ; en SSIM, l'étalon ×2 (−0,006) est à un
millième de la barre et `zone` (−0,025) nettement sous — la zone-plate à ×2 est de la reconstruction
de hautes fréquences pure, que douze texels font mieux que cinq ; c'est dit. En PSNR : au-dessus de
FSR1 sur `game` ×2 (+0,3 dB), l'étalon ×1,33 (+0,8) et le texte ×1,33 (+0,05), en dessous de 0,15 à
0,45 dB ailleurs à ×2. Contre SGSR1 (C4, « FLIP ≤ SGSR1 ») : égal sur le texte brut (0,071 contre
0,067, à l'écart près de la quantification) et au-dessus partout ailleurs, sans sa sonnerie.

### 2.4 Ce que P2.2 laisse

- **Au temps** : la table ne change pas le coût de P2.1 (`W_ACROSS` est un poids) ; les temps RTX et
  M1 du §1.4 valent pour elle.
- **À P2.3** : le feed externe et la passe 0 par plateforme (Apple : passe 0 par défaut, §1.4), la
  borne par échantillons au plus proche sur l'externe, `HALF`, `QUAD_UNIFORM`, `EARLY_OUT` par classe
  de GPU (gagnant sur NVIDIA et Apple ; à voir sur Mali et Adreno).
- **À P4** : `malioc` et un passage SweetOpt sur le chemin contour, qui attendent le texte GLSL du
  jumeau (le WGSL est fixé, ils ne le changeront plus).
- **À P5** : l'œil de Bruno sur l'étalon à ×2, là où FLIP met `mwsr` à +0,006 de FSR1 et à 0 % de
  dépassements contre 2 %.

## 3. P2.3 — les couches et les feeds (en cours, 21/10/2026)

### 3.1 Apple : la passe 0 reste

Créneau éclair sur le Mac M1 Pro au matin du 21/10 (journal J9) : la chaîne **passe 0 + noyau sur
RGBA** bat la lecture directe de la texture externe sur les quatre cas (texte ×2 : 0,32 ms contre
0,56 ; jeu 0,195 contre 0,213 ; interface 0,195 contre 0,265 ; texte ×1,33 : 0,295 contre 0,566),
même sans la borne exacte (0,51). Sans sortie anticipée l'externe monte à 1,1 ms. La chaîne
passe 0 + `mwsr` vaut 0,5 à 0,75 fois la chaîne SGSR1 livrée et un quart de FSR1 : **C1 tenue en
chaîne sur Apple**. La décision n° 2 du plan (§0, « pas de passe 0 en SDR ») devient donc un choix par
plateforme ; sur Apple, passe 0. Le 780M et le RTX sont remesurés avec `blit+mwsr` dans les mêmes
cellules avant de dire si « passe 0 partout » est la règle (elle serait la plus simple : un module, un
chemin commun au HDR et au contournement 1:1).

### 3.2 Le 780M et le RTX : la passe 0 partout, f16 sur AMD

Passes du 21/10 au matin (journal J10 ; les deux GPU en Chrome sans tête, adaptateur épinglé). Noyau
seul à ×2 vers 1440p, GPU p50 : **780M** `mwsr` 1,41 ms sur `text`, 0,65 sur `ui`, 0,58 sur `game`
(plancher 0,38 ; SGSR1 2,48 / 1,12 / 2,48 ; FSR1 9,3) ; **RTX** inchangé depuis P2.1.

| question | 780M | RTX | M1 (§3.1) | verdict |
|---|---|---|---|---|
| passe 0 + noyau contre texture externe, `text` | 1,53 contre 2,36 | 0,060 contre 0,096 | 0,32 contre 0,56 | **passe 0 partout** |
| … `game` | 0,74 contre 0,92 | 0,037 contre 0,043 | 0,195 contre 0,213 | idem |
| borne par échantillons contre `textureLoad` | +7 % | égal | — | sans objet, retirée |
| f16 sur le chemin contour | **−9 à −10 %** | −4 % | à mesurer | module `half` hors NVIDIA |
| sans sortie anticipée | 2,54 (×1,8 à ×4,4) | 0,086 (×1,7 à ×3) | ×2,7 à ×7 | la branche est le texte |

Les pixels de `half` et de la borne par échantillons sont ceux du f32 au centième de dB et de FLIP
(contrôle sur le RTX). **La décision n° 2 du plan est renversée par la mesure** : « pas de passe 0 en
SDR » valait pour un noyau à un ou deux fetches par pixel (P0) ; avec cinq échantillons et quatre
texels sur un tiers des pixels, les deux plans de la NV12 coûtent plus que la copie RGBA qu'ils
évitent, sur les trois classes de GPU mesurées. `mwsr` lit donc `texture_2d` après la passe 0 que le
renderer a déjà : un seul module, un seul bind group layout, le même chemin que le HDR et que le
contournement 1:1 ; le feed externe reste dans le générateur pour le labo seulement. Chaîne sur le
780M : passe 0 + `mwsr` 1,53 ms contre ≈ 2,7 pour passe 0 + SGSR1 et 9,5 pour passe 0 + FSR1 (× 0,16 :
C2 tenue avec marge), 1,38 avec `half`.

### 3.3 Ce que P2.3 laisse

- `QUAD_UNIFORM` : rien à écrire, la branche est uniforme par quad par construction.
- Le texte ne porte plus que `SHOW`, `W_ALONG`, `W_ACROSS`, `R_ALONG`, `R_ACROSS`, `S_FULL`,
  `W_MIN`, `DERING` et l'option de module `half` ; `DERING 0` reste le cran « performance » d'un GPU
  faible (−21 % sur le texte du 780M, au prix des dépassements de l'empreinte 2×2).
- Au realme Note 60 (Mali-G57, créneau de Bruno) : `half`, `DERING 0`, et la part du chemin contour
  sous le coût d'un GPU d'entrée de gamme ; à l'iPhone : `half` et la chaîne avec passe 0.
- P2.4 (compute par tuiles) : sans objet sur ordinateur, où le noyau est au plancher d'une passe
  (0,03-0,05 ms), et impossible sans copie sur mobile (§3.4) : proposée à l'abandon.
