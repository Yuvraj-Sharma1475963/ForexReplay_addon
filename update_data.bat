@echo off
rem Daily market data update: the newest EURUSD candles from MetaTrader 5 on this computer (or
rem Yahoo Finance if MT5 cannot be reached), checked, then pushed to GitHub so the website updates.
rem Windows Task Scheduler runs this every evening ("ForexReplay data update"); you can also
rem double-click it. What happened is written to data\update.log.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
echo ===== %date% %time% >> data\update.log
.venv\Scripts\python.exe -m forex_replay update --push >> data\update.log 2>&1
