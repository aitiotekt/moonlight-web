@echo off
REM mw-click-sound.exe from click-sound.cpp: MSVC x64, static CRT (runs on any client).
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
cl /nologo /O2 /EHsc /MT /std:c++17 click-sound.cpp /Fe:mw-click-sound.exe ole32.lib user32.lib gdi32.lib winmm.lib
del /q click-sound.obj 2>nul
