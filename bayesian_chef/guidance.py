"""Tasting-protocol advice and a library of suggested output measures.

Advice follows standard sensory-science practice. Main references:
  Lawless & Heymann, Sensory Evaluation of Food, 2nd ed. (Springer, 2010)
  Meilgaard, Civille & Carr, Sensory Evaluation Techniques, 5th ed. (CRC, 2016)
  Peryam & Pilgrim (1957), Food Technology 11:9-14 (9-point hedonic scale)
  Cabanac (1971), Science 173:1103-1107 (hunger changes how pleasant food tastes)
  MacFie et al. (1989), J. Sensory Studies 4:129-148 (serving-order effects)
  Lucak & Delwiche (2009), Chemosensory Perception 2:32-39 (palate cleansers)
"""

from __future__ import annotations

import json

PROTOCOL = {
    "60 min before": [
        "No food, coffee, alcohol, smoking, gum, or mint (toothpaste, mouthwash). "
        "Water is fine. 30 min is the usual panel minimum; 60 min is safer after strong or spicy food.",
        "Aim to be neither hungry nor full: mid-morning or mid-afternoon is ideal. Hunger "
        "makes everything taste better, which inflates scores (Cabanac 1971).",
        "Skip perfume, scented lotion, and scented hand soap; they interfere with aroma.",
    ],
    "Setup": [
        "Weigh ingredients; use a 0.01 g scale for anything under ~5 g (salt, spices, leavening).",
        "Make every sample the same size and serve them at the same temperature.",
        "Label samples only with the 3-digit codes. If someone can plate them for you, taste fully blind.",
        "Have room-temperature water and plain unsalted crackers ready to cleanse your palate.",
    ],
    "During": [
        "Taste in the printed order. It is randomised because the first sample in a session "
        "tends to be scored differently (MacFie et al. 1989).",
        "Score each sample before tasting the next. Don't go back and revise.",
        "Between samples: sip water, eat a bit of cracker, wait 30-60 s. "
        "Wait longer (2-3 min) after rich, salty, or spicy samples.",
        "Keep to about 4-6 samples per session. After that, fatigue and adaptation make scores noisy.",
        "For spicy samples, taste the mildest first if you can tell. Capsaicin burn carries over "
        "and dulls everything after it.",
    ],
    "After": [
        "Record every score right away, including any samples you disliked. Bad results are data too.",
        "Write down anything unusual (an ingredient swap, oven running hot, tasting while hungry) in notes.",
        "About every third session, re-run your best recipe so far. Comparing repeats shows how "
        "noisy your scores are.",
    ],
}


def protocol_text(sections: list[str] | None = None) -> str:
    """The tasting protocol as plain text, optionally only some sections."""
    lines = []
    for title, tips in PROTOCOL.items():
        if sections and title not in sections:
            continue
        lines.append(f"{title}:")
        lines += [f"  - {t}" for t in tips]
        lines.append("")
    return "\n".join(lines).rstrip()


# Suggested outputs. Keys match [[outputs]] fields in a project file.
OUTPUT_LIBRARY: dict[str, dict] = {
    # --- sensory -----------------------------------------------------------
    "liking": dict(
        category="sensory", goal="maximize", low=1, high=9, unit="1-9",
        how="9-point hedonic scale: 1 dislike extremely, 5 neither, 9 like extremely.",
    ),
    "vs_control": dict(
        category="sensory", goal="maximize", low=-3, high=3, unit="-3..+3",
        how="Compared with the control sample: -3 much worse, 0 same, +3 much better.",
    ),
    "salt_jar": dict(
        category="sensory", goal="target", target=3, low=1, high=5, unit="1-5",
        how="Just-about-right: 1 much too little salt, 3 just right, 5 much too much.",
    ),
    "sweet_jar": dict(
        category="sensory", goal="target", target=3, low=1, high=5, unit="1-5",
        how="Just-about-right: 1 much too little sweetness, 3 just right, 5 much too much.",
    ),
    "sour_jar": dict(
        category="sensory", goal="target", target=3, low=1, high=5, unit="1-5",
        how="Just-about-right: 1 much too little sourness, 3 just right, 5 much too much.",
    ),
    "texture_jar": dict(
        category="sensory", goal="target", target=3, low=1, high=5, unit="1-5",
        how="Just-about-right for the texture you want: 1 much too soft or runny, 3 just right, 5 much too firm.",
    ),
    "heat": dict(
        category="sensory", goal="target", target=5, low=0, high=10, unit="0-10",
        how="Heat intensity: 0 none, 10 the hottest you can stand. Set the target to your ideal.",
    ),
    # --- physical ----------------------------------------------------------
    "cook_loss_pct": dict(
        category="physical", goal="minimize", low=0, high=40, unit="%",
        how="Weigh before and after cooking: (raw - cooked) / raw x 100.",
    ),
    "core_temp_c": dict(
        category="physical", goal="target", target=60, low=40, high=90, unit="°C",
        how="Probe thermometer in the thickest part, right after cooking.",
    ),
    "height_mm": dict(
        category="physical", goal="maximize", low=0, high=150, unit="mm",
        how="Ruler at the tallest point, after cooling. For volume, use seed displacement.",
    ),
    "spread_ratio": dict(
        category="physical", goal="target", target=5, low=2, high=10, unit="ratio",
        how="Cookies and similar: diameter / height, after cooling.",
    ),
    "ph": dict(
        category="physical", goal="target", target=3.6, low=2.5, high=5.0, unit="pH",
        how="Calibrated pH meter. For shelf-stable acidified sauces, pH must be at or below 4.6 "
            "(aim for 4.0 or lower).",
    ),
    "brix": dict(
        category="physical", goal="target", target=10, low=0, high=40, unit="°Bx",
        how="Refractometer. Measures dissolved solids, mostly sugar.",
    ),
    "line_spread_mm": dict(
        category="physical", goal="target", target=40, low=10, high=80, unit="mm",
        how="Line-spread test for thickness: fill a ring with a fixed volume on a sheet printed with "
            "concentric circles, lift the ring, and read the average spread after 60 s.",
    ),
    "separation_s": dict(
        category="physical", goal="maximize", low=0, high=3600, unit="s",
        how="Emulsions: seconds until a visible layer separates in a clear jar.",
    ),
    "browning_L": dict(
        category="physical", goal="target", target=55, low=20, high=90, unit="L*",
        how="Phone photo beside a grey card under the same light each time. Read the L* lightness "
            "with a colour-picker app.",
    ),
    "crumb_open_pct": dict(
        category="physical", goal="maximize", low=0, high=50, unit="%",
        how="Photo of the cut face. Measure the hole area as a % of the slice (ImageJ threshold).",
    ),
    # --- practical ---------------------------------------------------------
    "active_min": dict(
        category="practical", goal="minimize", low=0, high=60, unit="min",
        how="Hands-on minutes (not waiting time).",
    ),
    "cost": dict(
        category="practical", goal="minimize", low=0, high=10, unit="$",
        how="Ingredient cost per serving.",
    ),
}


def output_toml(name: str, spec: dict) -> str:
    """A suggested output written as a TOML [[outputs]] block."""
    lines = ["[[outputs]]", f'name = "{name}"']
    for key in ("goal", "target", "low", "high", "weight", "unit", "how"):
        if key in spec and spec[key] is not None:
            v = spec[key]
            lines.append(f"{key} = {json.dumps(v, ensure_ascii=False)}")
    return "\n".join(lines)
