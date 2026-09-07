@echo off
cd /d "%~dp0"
python -m venv --without-pip .venv
if errorlevel 1 goto failed
python -m pip --python ".venv\Scripts\python.exe" install -r requirements.txt --index-url https://pypi.org/simple
if errorlevel 1 goto failed
".venv\Scripts\python.exe" prepare_model.py
if errorlevel 1 goto failed
echo Ready. Double click start.bat.
pause
exit /b 0
:failed
echo Setup failed. Please check the message above.
pause
exit /b 1
