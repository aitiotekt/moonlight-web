# ============================================================================
# mw-pyrowave-ref — the reference PyroWave codec, as an oracle for the POC
# Ultra ports (docs/design/ultra-lan-poc.md, U2.4).
#
# Upstream PyroWave (Hans-Kristian Arntzen, MIT, commit 509e4f88) encodes and
# decodes the lab corpus on Vulkan. Its streams and decoded frames are what the
# browser decoder (U3.4) and the HLSL encoder (U2.5) are checked against.
#
# A standalone project, never part of the product build nor shipped:
#   cmake -S backend/native-host/tools/pyrowave-ref -B build-pyrowave-ref -G Ninja
#         -DCMAKE_BUILD_TYPE=Release -DPYROWAVE_SRC=<pyrowave source tree>
# PYROWAVE_SRC is a checkout of upstream at 509e4f88 with its Granite subset
# (upstream's checkout_granite.sh). The tree vendored by punktfunk
# (crates/pyrowave-sys/vendor/pyrowave) is that pin plus bug fixes that leave
# the bitstream unchanged; it is the default when present.
# ============================================================================

cmake_minimum_required(VERSION 3.20)
project(mw-pyrowave-ref LANGUAGES CXX C)

set(PYROWAVE_SRC "E:/Code/punktfunk/crates/pyrowave-sys/vendor/pyrowave"
    CACHE PATH "PyroWave source tree (upstream 509e4f88 with Granite)")
if(NOT EXISTS "${PYROWAVE_SRC}/pyrowave_c.cpp")
    message(FATAL_ERROR "PYROWAVE_SRC (${PYROWAVE_SRC}) is not a PyroWave tree")
endif()

# Upstream's own standalone Granite configuration, static only.
set(GRANITE_RENDERER OFF CACHE BOOL "" FORCE)
set(GRANITE_VULKAN_SPIRV_CROSS OFF CACHE BOOL "" FORCE)
set(GRANITE_VULKAN_SHADER_MANAGER_RUNTIME_COMPILER OFF CACHE BOOL "" FORCE)
set(GRANITE_VULKAN_SYSTEM_HANDLES OFF CACHE BOOL "" FORCE)
set(GRANITE_SHADER_COMPILER_OPTIMIZE OFF CACHE BOOL "" FORCE)
set(GRANITE_POSITION_INDEPENDENT ON CACHE BOOL "" FORCE)
set(GRANITE_VULKAN_FOSSILIZE OFF CACHE BOOL "" FORCE)
set(GRANITE_SHIPPING ON CACHE BOOL "" FORCE)
set(GRANITE_PLATFORM "null" CACHE STRING "" FORCE)
add_subdirectory(${PYROWAVE_SRC}/Granite ${CMAKE_CURRENT_BINARY_DIR}/Granite EXCLUDE_FROM_ALL)
add_subdirectory(${PYROWAVE_SRC} ${CMAKE_CURRENT_BINARY_DIR}/pyrowave EXCLUDE_FROM_ALL)

# The C API, static (upstream ships it only as a shared library).
add_library(pyrowave-capi STATIC ${PYROWAVE_SRC}/pyrowave_c.cpp)
target_link_libraries(pyrowave-capi PRIVATE pyrowave granite-vulkan)
target_include_directories(pyrowave-capi PUBLIC ${PYROWAVE_SRC})
target_compile_definitions(pyrowave-capi PRIVATE _CRT_SECURE_NO_WARNINGS)

add_executable(mw-pyrowave-ref src/main.cpp)
target_compile_features(mw-pyrowave-ref PRIVATE cxx_std_17)
target_compile_definitions(mw-pyrowave-ref PRIVATE NOMINMAX _CRT_SECURE_NO_WARNINGS)
target_link_libraries(mw-pyrowave-ref PRIVATE pyrowave-capi pyrowave granite-vulkan granite-volk-headers)
