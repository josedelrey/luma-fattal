# Method and scope

[Overview](../README.md) · [Controls](configuration.md) · [Verification](development.md)

## Gradient-domain stylization

The filter builds a log-luminance pyramid, attenuates its gradients, and uses a
Poisson solver to reconstruct luminance. It then recombines the reconstructed
brightness with the source RGB. Fattal 1 accumulates attenuation across scales,
while Fattal 2 replaces the attenuation field at each finer scale. Both are
project variants of the approach described by
[Fattal, Lischinski, and Werman (2002)](#references).
The implementation operates on 8-bit SDR inputs.

Cross-Scale starts with the Fattal 1 gradient target. It separates log luminance
into bands with two Gaussian blurs. Gradient energy in the broader blur sets
the local gain before the Poisson solve. Cross-Scale boosts fine gradients and
pushes medium-scale shading in the opposite
direction, so strong settings can invert local relief. This middle band
contribution grows with the square of strength and is scaled independently by
Relief. Relief width changes the broader blur used for this contribution
independently of the contrast guide. The gain saturates as
broad contrast rises, with a fixed contrast scale so unrelated parts of a frame
do not change the gain.

The Cross-Scale equalizer builds a Laplacian pyramid of the difference between
the normalized Cross-Scale and Fattal 1 luminance maps clipped to 0–1. It adds
the weighted bands of this difference back to the clipped Fattal 1 map before
color recombination. All 0% or all 100% use
the corresponding single solve directly. Mixed settings need both maps.
The preview caches each map once computed so subsequent equalizer edits can
reuse both solves.

## Processing order

1. Decode, orient, and interpret color. Fit inputs larger than 8,000,000 pixels
   to the input-area budget.
2. Reduce to working resolution. Apply the pre curve, then any effects set to
   Pre. At this stage, apply highlight compression, vibrance, brightness and
   contrast, output levels, sharpening, and finishing in that order when
   enabled. Video then applies denoising, cleanup, and source noise as configured.
3. Attenuate log-luminance gradients and reconstruct brightness.
4. Apply tone strength, recombine color, and protect shadows.
5. Apply Post highlight compression, output gamma, Post vibrance, Post brightness
   and contrast, the post curve, and Post output levels in that order, then
   quantize to RGB8.
6. Apply any Post Sharpen and finishing effects at working resolution, then
   enlarge to the prepared input dimensions, apply Fade, and encode.

Halation and Local contrast share a downsampled guide for highlight glow and
broad brightness detail. Halation spreads bright areas into a warm halo, with
more glow at higher settings. Chroma bleed trails color from neighboring
pixels on the left. These effects and Split tone use the same sharpened RGB
input, add their contributions together, and clip once. Posterize applies last.

Tone strength blends source and mapped luminance before color reconstruction,
using working brightness after the pre curve and Pre effects, before denoising,
cleanup, and noise. Highlight compression scales channels together above a knee
at 75 percent of white. At full strength, it bounds finite, nonnegative RGB
peaks. Partial strength may still
leave bright values that clip.

Gamma applies `x^(1/gamma)` to clipped, normalized RGB. Vibrance increases channel
differences around weighted brightness, with a requested gain of
`1 + (vibrance / 100) * (1 - saturation)^2`, where saturation is `(max - min) / max`.
The gain is limited to keep channels in gamut, leaving grays and fully saturated
colors unchanged at this stage.

Shadow protection uses the working RGB and brightness after the pre curve and
Pre effects, before video source treatments. A positive
`shadow_softness` blends through a smoothstep interval around `shadow_threshold`,
while zero retains the hard cutoff. Subsequent post adjustments apply to the
protected result. Fade blends the finished image with the prepared original
at output resolution.

## Numerical choices

The reference path preserves the order of float32 operations, scalar power
approximations, and fixed boundary behavior. Selecting `power_mode: standard`
uses NumPy float64 powers, narrowing attenuation to float32 while retaining
float64 color recombination.

`detail_level` omits the finest attenuation scales and interpolates retained
fields through the excluded levels. Omitting every level gives unit attenuation,
although reconstruction and normalization still apply. `pyramid_min_size`
controls the coarsest scale. Fractional luminance skips integer rounding before
the logarithm, but cannot recover detail lost in an 8-bit source.

Bilinear and bicubic reduction to working resolution use no antialias prefilter
and truncate their results to RGB8. Bicubic sampling uses the scalar kernel with
`a = -0.75` and clamps overshoot. Input-area fitting and enlargement use separate,
fixed resamplers.

Experimental controls skip their added operations when set to neutral values.
Frozen references check numerical and encoding behavior for the tested cases.

## Color handling

By default, image processing applies EXIF orientation and converts supported RGB
matrix/TRC ICC profiles to sRGB. Other profiles can fall back to Little CMS,
which can produce different numerical results.
Reference JPEG export uses quality 100, 4:2:0 chroma subsampling, and no embedded
profile. In-memory Pillow results carry an sRGB ICC profile when the sRGB policy
is used for color conversion. NumPy callers supply already interpreted RGB pixels.

## Scope

The supported image workflow is opaque 8-bit SDR JPEG and PNG. The gradient
solver operates on RGB8. Straight RGBA is available through explicit
configuration or the `core` profile as an experimental extension.

The [video adapter](video.md) prepares inputs through FFmpeg and produces silent
SDR H.264 output at a constant frame rate. It filters each frame independently,
with source cleanup retaining only mask history.

## References

- Raanan Fattal, Dani Lischinski, and Michael Werman (2002).
  [Gradient Domain High Dynamic Range Compression](https://doi.org/10.1145/566570.566573).
