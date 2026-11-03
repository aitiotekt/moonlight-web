# ============================================================================
# mw-pyrowave-d3d12 — the PyroWave encoder ported to HLSL on D3D12 compute
# (POC Ultra, docs/design/ultra-lan-poc.md, U2.5).
#
# PyroWaveEncoder12 is the class the engine's Ultra encoder (UltraEncoder12,
# U4) runs; the tool runs it on a Y4M clip and writes the stream the way
# mw-pyrowave-ref does, so the reference decoder checks it. Port of
# PyroWave by Hans-Kristian Arntzen (MIT, commit 509e4f88): see the notices
# in src/.
#
# A standalone project, never part of the product build nor shipped (it
# leaves build/ alone, which running --dev instances use):
#   cmake -S backend/native-host/tools/pyrowave-d3d12 -B build-pyrowave-d3d12 -G Ninja
#         -DCMAKE_BUILD_TYPE=Release
# The shaders compile at run time with d3dcompiler (shader model 5.0), as the
# engine's do: the HLSL is embedded as a string at configure time.
# ============================================================================

cmake_minimum_required(VERSION 3.20)
project(mw-pyrowave-d3d12 LANGUAGES CXX)

# The encoder class is the engine's (src/encode/windows/d3d12): the tool runs
# the very code the native host does.
set(_engine ${CMAKE_CURRENT_SOURCE_DIR}/../../src/encode/windows/d3d12)
set(_hlsl ${_engine}/PyroWaveEncoder12.hlsl)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${_hlsl})
file(READ ${_hlsl} _hex HEX)
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," _bytes "${_hex}")
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/PyroWaveEncoder12Hlsl.h
     "// Generated from PyroWaveEncoder12.hlsl at configure time.\n#pragma once\n"
     "static const char kPyroWaveEncoderHlsl[] = {${_bytes}0x00};\n")

add_executable(mw-pyrowave-d3d12 src/main.cpp ${_engine}/PyroWaveEncoder12.cpp)
target_compile_features(mw-pyrowave-d3d12 PRIVATE cxx_std_17)
target_compile_definitions(mw-pyrowave-d3d12 PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
target_include_directories(mw-pyrowave-d3d12 PRIVATE ${CMAKE_CURRENT_BINARY_DIR} ${_engine})
target_link_libraries(mw-pyrowave-d3d12 PRIVATE d3d12 dxgi d3dcompiler)
if(MSVC)
    target_compile_options(mw-pyrowave-d3d12 PRIVATE /W4 /utf-8)
endif()
