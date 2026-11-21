# CAM-MIDI — Cámara del sistema → MIDI

**Versión 1.00**

Cualquier cámara DirectShow de Windows → detección de movimiento en 3 bandas (graves / medios / agudos) → MIDI en **Max**, con audio por **WinMIDI (GS Wavetable)**.

Basado en el motor de [MAX-VIEW Microscope MIDI](https://github.com/fernandoog/maxview-microscope-midi), sin microscopio WiFi.

## Requisitos

- Windows 10/11
- [Max 8/9](https://cycling74.com/) o Max incluido en Ableton Live
- [Node.js](https://nodejs.org/) ≥ 18 (npm en PATH)
- Una cámara del sistema (webcam USB, integrada, virtual…)

## Arranque rápido

1. Descarga el release **v1.00** y descomprime.
2. En la carpeta del proyecto:
   ```bat
   npm install
   ABRIR_CamMIDI.bat
   ```
   O abre `CamMIDI.maxpat` en Max.
3. Primera vez: el patch instala deps si hace falta (`sharp` + `ffmpeg-static`).
4. Auto-start usa la primera cámara. **next** cambia de dispositivo.
5. Solo suena con **movimiento** delante de la cámara.

## Controles

| Acción | Efecto |
|--------|--------|
| start / stop | Arranca / para captura + MIDI |
| next | Siguiente cámara DirectShow |
| Video | Abre preview (Full / Win / Mon1 / Mon2) |

### Mensajes a `node.script`

`start` · `stop` · `devices` · `device <n|nombre>` · `next` · `freeze` · `sensitivity` · `gate` · `noise` · `scale` · `fps` · `size` · `fxvis`

Escalas: `major` `minor` `pentatonic` `chromatic`

## Archivos

| Archivo | Rol |
|---------|-----|
| `CamMIDI.maxpat` | Panel de control (presentación) |
| `CamMIDI_Preview.maxpat` | Ventana de vídeo |
| `cam_midi.js` | Node: cámara, motion, MIDI, WinMIDI |
| `cam_boot.js` | Audio + abrir preview |
| `cam_window.js` | Escalado Full/Mon |
| `win_midi_daemon.ps1` | MIDI → altavoces Windows |
| `ABRIR_CamMIDI.bat` | Lanza Max con el patch |

## Notas

- Si la cámara está en uso por otra app, ciérrala primero.
- Si el panel queda en blanco: cierra Max por completo y vuelve a abrir `CamMIDI.maxpat`.

## Relacionados

- [maxview-microscope-midi](https://github.com/fernandoog/maxview-microscope-midi) — microscopio WiFi JoyHonest
- [maxview-desktop](https://github.com/fernandoog/maxview-desktop) — visor Windows (foto/vídeo)

## Licencia

MIT — © 2026 fernandoog
