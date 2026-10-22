@echo off
rem Market data update, only when you run it (double-click): the newest EURUSD candles from
rem MetaTrader 5 on this computer (or Yahoo Finance if MT5 cannot be reached), checked, then pushed
rem to GitHub so the website updates. The app's "Update data" button does the same.
rem What happened is written to data\update.log.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
echo ===== %date% %time% >> data\update.log
.venv\Scripts\python.exe -m forex_replay update --push >> data\update.log 2>&1
