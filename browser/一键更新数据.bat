@echo off
chcp 65001 >nul
title OurNotes Planner - Update Data Snapshot
cd /d "%~dp0"

echo.
echo   ================================================================
echo    Update master data snapshot for the team planner
echo   ================================================================
echo.
echo   This fetches the CURRENT master data from the official server
echo   (public endpoint, no login needed) and writes only the tables
echo   that actually changed into snapshot-override\.
echo.
echo   Then it rebuilds, so the page picks them up.
echo.
echo   Use this after the game starts a new event (bonus characters /
echo   bonus rates change) or adds new songs / cards.
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo   [X] Python not found on PATH. Install Python 3.10+ first.
    pause
    exit /b 1
)

echo   --- Step 1/2: fetch and compare -------------------------------
echo.
python -B update_snapshot.py --apply
if errorlevel 1 (
    echo.
    echo   [X] Snapshot update failed. Nothing was rebuilt.
    pause
    exit /b 1
)

echo.
echo   --- Step 2/2: rebuild ------------------------------------------
echo.
python -B build_browser.py --build
if errorlevel 1 (
    echo.
    echo   [X] Build failed. The previous build is still in dist\.
    pause
    exit /b 1
)

echo.
echo   ================================================================
echo    Done. Open the page and hard-refresh with Ctrl+Shift+R.
echo   ================================================================
echo.
pause
