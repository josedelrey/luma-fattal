#!/usr/bin/env bash
set -euo pipefail

task_root=$(cd "$(dirname "$0")/.." && pwd)
ffmpeg_build="$task_root/outputs/ffmpeg"
ffmpeg_prefix="$ffmpeg_build/prefix"
mkdir -p "$ffmpeg_prefix"
export PKG_CONFIG_PATH="$ffmpeg_prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
export CFLAGS="-O2 -fPIC"
export CXXFLAGS="-O2 -fPIC"
ffmpeg_jobs=${LUMA_FATTAL_BUILD_JOBS:-4}

cd "$ffmpeg_build/source/zlib"
./configure --static --prefix="$ffmpeg_prefix"
make -j"$ffmpeg_jobs"
make install

cd "$ffmpeg_build/source/x264"
./configure --prefix="$ffmpeg_prefix" --enable-static --enable-pic --disable-cli --disable-opencl
make -j"$ffmpeg_jobs"
make install

cd "$ffmpeg_build/source/zimg"
./autogen.sh
if [[ "$(uname -s)" == Darwin ]]; then export STL_LIBS="-lc++"; fi
./configure --prefix="$ffmpeg_prefix" --enable-static --disable-shared --with-pic
make -j"$ffmpeg_jobs"
make install

ffmpeg_options=(
  --prefix="$ffmpeg_prefix" --disable-shared --enable-static --disable-autodetect
  --disable-doc --disable-debug --disable-ffplay --disable-network
  --enable-gpl --enable-libx264 --enable-libzimg --enable-zlib
  --pkg-config-flags=--static --extra-cflags="-I$ffmpeg_prefix/include"
  --extra-ldflags="-L$ffmpeg_prefix/lib" --extra-libs=-lm
)
case "$(uname -s)" in
  MINGW*|MSYS*)
    ffmpeg_options+=(--target-os=mingw32 --extra-ldflags="-L$ffmpeg_prefix/lib -static -static-libgcc -static-libstdc++")
    ;;
  Linux*) ffmpeg_options+=(--extra-ldflags="-L$ffmpeg_prefix/lib -static-libgcc -static-libstdc++") ;;
esac
if [[ "$(uname -s)" != Darwin ]]; then
  make -C "$ffmpeg_build/source/nv-codec-headers" PREFIX="$ffmpeg_prefix" install
  ffmpeg_options+=(--enable-ffnvcodec --enable-nvenc --disable-cuvid --disable-nvdec)
fi
cd "$ffmpeg_build/source/ffmpeg"
./configure "${ffmpeg_options[@]}" || { tail -n 120 ffbuild/config.log; exit 1; }
make -j"$ffmpeg_jobs"
make install
cp ffbuild/config.log "$ffmpeg_build/provenance/config.log"
cp config.h "$ffmpeg_build/provenance/config.h"
"$ffmpeg_prefix/bin/ffmpeg" -version > "$ffmpeg_build/provenance/version.txt"
"$ffmpeg_prefix/bin/ffmpeg" -hide_banner -filters 2>/dev/null | grep -w zscale
"$ffmpeg_prefix/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -w libx264
