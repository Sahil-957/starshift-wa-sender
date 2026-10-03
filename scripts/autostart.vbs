' Starts the Starshift WA Sender backend + ngrok tunnel in hidden windows.
' Put a copy of this file in the Windows Startup folder (Win+R -> shell:startup) to run it at login.
Set sh = CreateObject("WScript.Shell")
dir = "C:\Users\sahil\OneDrive\Desktop\Whatsapp_bulksms_sender_extention\scripts\"
sh.Run """" & dir & "start-backend.bat""", 0, False
sh.Run """" & dir & "start-ngrok.bat""", 0, False
