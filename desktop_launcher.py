import os
import sys
import subprocess
import webbrowser

URL = "https://disc2-0.onrender.com"

def launch():
    # Caminhos padrão do Microsoft Edge e Google Chrome (presentes em 100% dos PCs Windows)
    candidates = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]

    for exe in candidates:
        if os.path.isfile(exe):
            try:
                # O parâmetro --app=URL abre como aplicativo nativo (janela limpa sem abas nem barra de busca)
                # Flags adicionadas para garantir aceleração de hardware e autoplay sem restrição
                subprocess.Popen([
                    exe,
                    f"--app={URL}",
                    "--start-maximized",
                    "--autoplay-policy=no-user-gesture-required",
                    "--enable-features=WebRtcHideLocalIpsWithMdns",
                    "--enable-gpu-rasterization",
                    "--enable-zero-copy"
                ])
                return
            except Exception:
                pass

    # Fallback caso não encontre
    webbrowser.open(URL)

if __name__ == "__main__":
    launch()
