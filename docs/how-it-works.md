# How Bayesian Chef works

This guide explains every idea the app uses, from scratch. You don't need
any statistics background: if you know what an average and a graph are,
you can follow it. Each section ends with where the idea lives in the code,
so you can go and look.

**Contents**

1. [The big idea: a map of recipes](#1-the-big-idea-a-map-of-recipes)
2. [Factors and outputs](#2-factors-and-outputs)
3. [Step 1: the initial design](#3-step-1-the-initial-design)
4. [Step 2: turning several scores into one](#4-step-2-turning-several-scores-into-one)
5. [Step 3: the model (Gaussian processes)](#5-step-3-the-model-gaussian-processes)
6. [Step 4: choosing the next recipes](#6-step-4-choosing-the-next-recipes)
7. [Step 5: tasting like a scientist](#7-step-5-tasting-like-a-scientist)
8. [Reading the Insights screen](#8-reading-the-insights-screen)
9. [Honest limits](#9-honest-limits)
10. [Glossary](#10-glossary)
11. [Sources](#sources)

---

## 1. The big idea: a map of recipes

Picture every possible lemonade laid out on a map. Walking east adds more
lemon; walking north adds more sugar. Every spot on the map is one recipe,
and every spot has a height: how good that lemonade tastes to you.

You want the highest hill, but the map is covered in fog. Each time you
make and taste a lemonade, you clear the fog at one spot and learn its
height. Tasting is expensive (time, ingredients, your stomach), so you can
only clear maybe 30 spots.

Bayesian optimisation is a strategy for choosing *which* spots to clear:

- Use the spots you've already seen to **guess the height everywhere
  else**, and also how **unsure** that guess is. That's the *model*.
- Next, check spots that are **probably high** (exploit what you know) or
  **very uncertain** (explore, in case there's a hidden hill). That's the
  *acquisition*.

Real recipes have more than two knobs, so the "map" has more than two
directions. You can't draw a 6-direction map, but the maths works exactly
the same way.

## 2. Factors and outputs

A **factor** is something you change between recipes. Every factor has a
type:

| Type | Example | What the app needs |
|---|---|---|
| Number | pan temperature, 120–200 °C | lowest and highest value |
| Whole number | eggs, 2–4 | lowest and highest value |
| Choice | fat: butter, ghee or olive oil | the options |
| Blend part | lemon juice, as part of a drink that always adds to 100% | range, plus which blend it belongs to |

**Blends** are for ingredients that share a fixed total. In the lemonade,
water, lemon juice and sweetener must add up to 100% of the drink. If the
app raises the lemon juice, something else has to go down. The app always
generates blends that add up exactly. (In the code: `sampleMixture` in
`app/engine/space.js`.)

**Log scale** is an option for factors where *doubling* matters more than
*adding*. An oil-to-vinegar ratio going from 1:1 to 2:1 is a big change;
going from 4:1 to 5:1 is small. On a log scale the app treats those two
steps fairly.

An **output** is something you measure or score for every sample. Each one
has a goal:

- **Higher is better**, like "how much do I like it, 1–9".
- **Lower is better**, like weight lost while cooking.
- **Hit a target**, like "sweetness: 1 too little, 3 just right, 5 too
  much" with a target of 3. These are called *just-about-right* scales.

**Behind the scenes:** the maths only understands numbers between 0 and 1,
so every factor gets rescaled. A pan temperature of 160 °C in a 120–200
range becomes (160 − 120) ÷ (200 − 120) = 0.5. A choice like "ghee" becomes
a set of on/off switches, one per option (butter = 0, ghee = 1, olive oil = 0).
This is called *one-hot encoding*. (In the code: `encode` in
`app/engine/space.js`.)

## 3. Step 1: the initial design

Before the model can predict anything, it needs some data. The first
sessions are an **initial design**: recipes chosen to cover your ranges as
evenly as possible. By default it's `max(6, 2 × number of factors)`
recipes, so a 6-factor omelette starts with 12.

### Why not pick at random?

Random picks clump. With 10 random recipes you'll often get three almost
identical ones and a big empty region. Clumped recipes teach the model the
same thing three times.

### Latin hypercubes

A **Latin hypercube** is a smarter way to spread points. Split each factor's
range into as many slices as you have recipes, then place exactly one recipe
in each slice of *every* factor. Here's one with 5 recipes and 2 factors:

```
 sugar
   ^
   |  .  .  X  .  .
   |  X  .  .  .  .
   |  .  .  .  .  X
   |  .  X  .  .  .
   |  .  .  .  X  .
   +-------------------> lemon
```

Every row has one X and every column has one X, so every lemon level and
every sugar level gets tried once. (It's the same rule as placing rooks on a
chessboard so none can attack another.)

A plain Latin hypercube can still be bad: the X's could all sit on a
diagonal line. So the app **optimises** it. It starts from a random Latin
hypercube and repeatedly swaps values between two recipes, keeping each swap
only if it makes the design better. Swapping never breaks the
one-per-slice rule. It tries 2,000 swaps by default.

"Better" can mean two things, and you can pick either in Advanced
settings:

- **MaxPro** (the default) punishes any two recipes that are close on *any
  single factor or pair of factors*. That matters because the model tries
  to learn how much each factor matters on its own, and it can only do that
  if each factor was tried across its whole range.
- **Maximin** pushes the two closest recipes as far apart as possible,
  considering all factors at once.

If you've set **your current recipe** (the baseline), it's always cooked
first. It gives every later recipe a fair comparison, and the rest of the
design is spread around it.

(In the code: `optimizeLHS` and `design` in `app/engine/space.js`. The
Insights → Model details view shows how well-spread your design is.)

## 4. Step 2: turning several scores into one

If you score liking, texture and cooking loss, which recipe is "best"? The
app turns each output into a **desirability** between 0 (worst) and 1
(ideal), then combines them.

For each output, using its lowest and highest values:

- **Higher is better:** desirability = (score − lowest) ÷ (highest − lowest)
- **Lower is better:** desirability = (highest − score) ÷ (highest − lowest)
- **Target:** desirability = 1 − (distance from target) ÷ (largest possible distance)

Anything outside 0–1 is clipped.

### A worked example

The omelette template judges three outputs:

| Output | Goal | Range | Weight | Your score | Desirability |
|---|---|---|---|---|---|
| Liking | higher is better | 1–9 | 2 | 7 | (7 − 1) ÷ 8 = **0.75** |
| Texture | target 3 | 1–5 | 1 | 3 | right on target = **1.00** |
| Cook loss % | lower is better | 0–20 | 0.5 | 10 | (20 − 10) ÷ 20 = **0.50** |

The **weights** say how much each output counts. Liking has weight 2, so it
counts twice as much as texture.

The app combines these with a **weighted geometric mean**:

```
score = (0.75^2 × 1.00^1 × 0.50^0.5) ^ (1 ÷ (2 + 1 + 0.5))
      = 0.768
```

Why a geometric mean instead of a normal average? Because it punishes
recipes that fail badly on one thing. A recipe you love (1.0) that loses
half its weight in the pan (0.0) would average 0.5, which sounds fine. The
geometric mean pulls it down to nearly nothing, which matches how you'd
actually feel about it. (Very low values are floored at 0.01 so the maths
never hits exactly zero.) If you'd rather have a plain average, or judge a
recipe by its worst output, change **Advanced settings → Scoring**.

(In the code: `desirability`, `combine` and `runScore` in
`app/engine/optimize.js`. The test suite checks this exact example.)

## 5. Step 3: the model (Gaussian processes)

This is the heart of the app. After each session, the app fits one
**Gaussian process** (GP) per output. Here's what that means without the
equations.

### The idea

Imagine plotting liking against pan temperature, with a dot for every
omelette you've tasted. A GP draws a smooth curve through the dots, and
also a **band** around the curve showing how sure it is:

```
liking
  9 |                    .-~~-.
    |        ●       .-~        ~-.   ← wide band: no data here,
  7 |    ●  /  \  .-~              ~-.   the model is unsure
    |   /       ●                     
  5 | ●                                
    |                                  
  3 +----------------------------------> pan temperature
     120      140      160     180    200
```

- Near your dots the band is narrow: the model is confident.
- Far from any dot the band is wide: "I don't know, could be good or bad".

That band is exactly what you need to decide where to look next.

### How it draws the curve

A GP rests on one simple belief: **recipes that are similar taste
similar**. Two omelettes cooked at 160 °C and 162 °C should score about the
same. Two at 120 °C and 200 °C could be completely different.

The **kernel** is the rule for "how similar is similar". It turns the
distance between two recipes into a number between 0 (unrelated) and 1
(identical). The app offers five kernels, which differ in how smooth they
assume taste is:

| Kernel | Assumes the response is… |
|---|---|
| RBF (squared exponential) | very smooth, like a rolling hill |
| Matérn 5/2 (the default) | smooth, but allowed a few sharper bends |
| Matérn 3/2 | rougher |
| Exponential (Matérn 1/2) | quite jagged |
| Rational quadratic | a mix of smooth and wiggly at different scales |

Matérn 5/2 is the usual choice for this kind of optimisation, because real
responses are smooth but rarely perfectly so.

### The three settings a GP learns

- **Lengthscale:** how far you have to move before taste changes a lot. A
  lengthscale of 0.35 means "about a third of the range". Short lengthscale:
  taste changes quickly with that factor. Long lengthscale: the factor
  barely matters.
- **Signal size:** how big the ups and downs are overall.
- **Noise:** how much your scores wobble even for the same recipe. Nobody
  scores the same omelette identically twice, and the model knows that, so
  it won't bend the curve to hit every dot exactly.

The app learns these from your data by finding the values that make your
scores most likely (the *marginal likelihood*). It uses a search method
called **Nelder–Mead**, which tries a small triangle of guesses and keeps
rolling it downhill, from 3 different starting points. It keeps the best.

With very little data, that search can latch onto noise, so the app uses
**priors**: gentle nudges toward sensible values (for example, lengthscale
around 0.35 and noise around 0.4 on the rescaled score). Below 5 results
the app doesn't search at all and just uses the prior values.

### ARD: one lengthscale per factor

By default all numeric factors share one lengthscale. Turn on **ARD**
(automatic relevance determination) and each factor gets its own. Then the
model can tell you "salt matters a lot, resting time barely matters".

The catch: every extra lengthscale is one more thing to learn from the same
few scores. With 6 factors and 10 results, ARD will often invent patterns
from noise. The app warns you until you have about 3 results per numeric
factor.

### The alternative: polynomial regression

**Bayesian polynomial regression** assumes the response is a simple curved
shape (a bowl, a ridge or a saddle) rather than any smooth shape. It needs
fewer results but can't capture anything more complicated. It's in
Advanced settings → Model.

(In the code: `fitGP` and `fitBLR` in `app/engine/models.js`.)

## 6. Step 4: choosing the next recipes

Now the model has a curve and a band for every output. Which recipes should
you cook next?

### Explore versus exploit

- **Exploit:** cook what the model predicts is best. Safe, but if the model
  is wrong about an unexplored region, you'll never find out.
- **Explore:** cook where the model is most unsure. You learn a lot, but
  might eat some bad lemonade.

Every acquisition method is a different way to balance the two.

### Where the candidates come from

The app can't check every possible recipe, so it builds a pool of 600
candidates: about 70% spread across your whole range, and about 30% small
variations of your 3 best recipes so far. It then scores every candidate.

### Thompson sampling (the default)

Thompson sampling is the easiest to picture. The model's band means many
different curves are plausible. So:

1. Draw one plausible curve at random from the model.
2. Pick the candidate that's best on *that* curve.
3. Repeat for each slot in the session, drawing a fresh curve each time.

Where the model is confident, every drawn curve looks similar, so you get
the predicted best. Where it's unsure, some drawn curves happen to be high
there, so those regions get tried now and then. Exploring and exploiting
balance themselves with no extra settings.

### The other methods

| Method | Picks the candidate with… |
|---|---|
| Expected improvement (EI) | the biggest *average* amount by which it might beat your current best |
| Probability of improvement (PI) | the highest *chance* of beating your current best |
| Upper confidence bound (UCB) | the highest "prediction + β × uncertainty". A bigger β explores more. |
| Pure exploitation | the highest prediction |
| Pure exploration | the most uncertainty |

For these, a session with several slots needs a trick so it doesn't pick
the same recipe three times. After each pick, the app pretends it already
cooked that recipe and got the predicted score (the **kriging believer**
strategy), then picks again. The model is now confident near the first
pick, so the second pick goes elsewhere.

### Presets

**Advanced settings → How adventurous?** gives three presets:

- **Balanced:** Thompson sampling. The default.
- **Explore:** UCB with a large β, fewer candidates near your best recipes.
  Good early on.
- **Refine:** expected improvement, most candidates near your best
  recipes. Good when you're close.

### Rejected recipes and repeats

- When you **reject** a proposal, the app lowers the value of candidates
  near it, so it won't keep suggesting similar recipes.
- Once the model is choosing, every **third session** with at least 2
  samples uses one slot to repeat your best recipe so far. If you
  score the same recipe 7 one day and 5 the next, that gap tells you how
  noisy your palate is, which appears on Insights as **palate noise**.

(In the code: `propose`, `acquire`, `candidatePool` and `noGoFactors` in
`app/engine/optimize.js`.)

## 7. Step 5: tasting like a scientist

The model is only as good as your scores. Tasting has surprising biases,
and professional sensory panels use rules to avoid them. The app builds
those rules in.

| Rule | Why |
|---|---|
| **Blind 3-digit codes** | If you know which sample is "the new one", you'll score it differently. Codes hide that. |
| **Random tasting order** | The first sample in a session tends to be scored differently from the rest, whatever it is. Random order spreads that bias out instead of always hitting the same recipe. |
| **No food, coffee, gum or mint 30–60 minutes before** | Strong flavours linger and change how the next thing tastes. |
| **Neither hungry nor full** | When you're hungry, everything tastes better. Hunger literally changes how pleasant food feels, which inflates scores. |
| **Water and plain crackers between samples** | Resets your mouth so one sample doesn't bleed into the next. |
| **4–6 samples per session** | After that, taste fatigue makes scores noisy. |

### The scales

- **The 9-point hedonic scale** (1 = dislike extremely, 5 = neither,
  9 = like extremely) has been the standard way to measure liking since
  1957.
- **Just-about-right scales** (1 = much too little, 3 = just right,
  5 = much too much) tell you *which way* to change something, not just
  whether it's good.

(In the code: `PROTOCOL` and `OUTPUT_LIBRARY` in `app/engine/library.js`.
The full checklist is in the app under the **?** button.)

## 8. Reading the Insights screen

| Chart | What it shows | How to use it |
|---|---|---|
| **Best so far** | your highest-scoring tasted recipe | your current recipe to beat |
| **Model's best guess** | the untested recipe the model expects to score highest | worth cooking, but the model can be wrong |
| **What matters** | how much the overall score changes as each factor moves across its range, as a share of the total | focus on the big bars; consider fixing factors near 0% |
| **Progress** | every tasted recipe's score, plus the best so far | the line should step up over time |
| **Effects** | the average predicted score as one factor changes, with an uncertainty band | shows *which direction* to move each factor |
| **Surface** | a heat map of the predicted score over two factors, others held at your best recipe | find sweet spots where two factors interact |
| **Model check** | each recipe predicted by a model that never saw it | tells you whether to trust the model |
| **PCA map** | your recipes squashed onto the two directions where they differ most | spot clusters and unexplored gaps |
| **All runs** | every recipe as one line across all factors | drag along an axis to filter |
| **Correlations** | how pairs of factors and outputs move together | treat anything between −0.5 and 0.5 as noise with few recipes |
| **Trade-offs** | recipes that can't improve one output without hurting another (the *Pareto front*) | choose the balance you like |

### Is the model any good?

The **Model fit** number is an R² from **leave-one-out** checking. For each
tasted recipe, the app predicts its score using all the *other* recipes, as
if it had never tasted that one, then compares with what you actually
scored.

- **R² near 1:** the model predicts new recipes well.
- **R² near 0:** it predicts about as well as "always guess the average".
- **Below 0:** worse than guessing the average. You need more data, or
  your scores are very noisy.

For a single liking score with around 30 tastings, 0.2–0.5 is normal. Taste
is noisy.

(In the code: `analytics.js`, especially `mainEffects`, `diagnostics` and
`runPCA`.)

## 9. Honest limits

- **Your palate is the measuring instrument, and it's noisy.** If your
  scores for the same recipe vary by ±1.5 on a 1–9 scale, no model can find
  differences smaller than that. Repeats measure this; blind tasting reduces
  it.
- **Small data.** 20–40 tastings is very little by statistics standards.
  Keep the number of factors small (4–6), and fix any you already know.
- **More settings isn't better.** ARD, input PCA and exotic kernels need
  more data than a kitchen usually produces. The Advanced settings panel
  warns you when a setting doesn't suit the amount of data you have.
- **Input PCA rarely helps here.** It compresses factors that move
  together, but a good initial design deliberately makes them move
  independently.

## 10. Glossary

| Term | Meaning |
|---|---|
| Acquisition | the rule for choosing the next recipes |
| ARD | a separate lengthscale for every factor |
| Baseline | your current recipe, cooked first as a reference |
| Blend | factors that must add up to a fixed total |
| Candidate | a possible recipe the app considers proposing |
| Desirability | an output rescaled to 0 (worst) – 1 (ideal) |
| DOE | design of experiments: planning which runs to do |
| Factor | something you change between recipes |
| Gaussian process | a model that predicts a smooth surface plus its uncertainty |
| Hyperparameter | a setting of the model itself, like lengthscale or noise |
| Kernel | the rule for how similar two recipes are |
| Latin hypercube | a design with exactly one run in each slice of every factor |
| Lengthscale | how far a factor must change before the output changes a lot |
| Leave-one-out | testing a model on each point it wasn't trained on |
| Output | something you score or measure |
| Pareto front | results that can't improve on one goal without losing on another |
| PCA | principal component analysis: finding the directions of biggest variation |
| Prior | what the model assumes before seeing data |
| R² | the share of variation a model explains, 1 is perfect |
| Thompson sampling | choosing by drawing one plausible world and taking its best |

## Sources

- Lawless & Heymann, *Sensory Evaluation of Food*, 2nd ed. (Springer, 2010)
- Meilgaard, Civille & Carr, *Sensory Evaluation Techniques*, 5th ed. (CRC, 2016)
- Peryam & Pilgrim (1957), *Food Technology* 11:9–14: the 9-point hedonic scale
- Cabanac (1971), *Science* 173:1103–1107: hunger changes how pleasant food tastes
- MacFie et al. (1989), *Journal of Sensory Studies* 4:129–148: serving-order effects
- Lucak & Delwiche (2009), *Chemosensory Perception* 2:32–39: palate cleansers
- Joseph, Gul & Ba (2015), *Biometrika* 102:371–380: MaxPro designs
- Morris & Mitchell (1995), *Journal of Statistical Planning and Inference* 43:381–402: maximin Latin hypercubes
- Rasmussen & Williams, *Gaussian Processes for Machine Learning* (MIT Press, 2006), free online
- Shahriari et al. (2016), "Taking the Human Out of the Loop: A Review of Bayesian Optimization", *Proceedings of the IEEE* 104:148–175
