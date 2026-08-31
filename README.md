# LOELSTI

Eigenständige Echtzeit-Kommunikationsplattform mit Web/PWA-Grundlage, API und installierbarer Desktop-App.

## Struktur
- `apps/web` – React + TypeScript + Vite Frontend, das im Browser und innerhalb der Desktop-App läuft
- `apps/api` – Node + TypeScript + Express + Socket.IO API
- `apps/desktop` – Tauri-2-Desktop-Client für Windows, macOS und Linux
- `apps/download-site` – eigenständige Download-Seite für die Desktop-App
- `packages` – Platz für gemeinsam nutzbare UI-/Typ-/SDK-Pakete

## Lokal
1. `.env.example` nach `.env` kopieren.
2. `npm install`
3. PostgreSQL starten: `docker compose up -d postgres`
4. Datenbank migrieren: `npm run db:migrate`
5. Web + API starten: `npm run dev`
6. Desktop-App im Entwicklungsmodus starten: `npm run desktop:dev`

## Desktop-App bauen
`npm run desktop:build`

Der Tauri-Client bündelt das gebaute `apps/web`-Frontend in einer eigenen Desktop-Anwendung. Die App wird nicht als Browser-Tab geöffnet.

## Releases
Desktop-Releases werden über Tags im Format `desktop-v*` veröffentlicht. Die GitHub-Actions-Pipeline baut je nach Runner Windows-Installer (NSIS/MSI), macOS-DMG und Linux-Pakete. Die Download-Seite liest das aktuelle GitHub-Release aus und verlinkt verfügbare Installer direkt.

Beispiel:
`git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`

## Download-Seite
Die statische Download-Seite liegt unter `apps/download-site`. Nach Aktivierung von GitHub Pages kann sie direkt über Pages veröffentlicht werden; die enthaltene Workflow-Datei übernimmt den Deployment-Schritt.

## API-Konfiguration
Die Desktop- und Web-App verwenden `VITE_API_URL` zur Auswahl der LOELSTI-API. Für eine veröffentlichte Desktop-Version muss diese Variable beim Build auf die produktive API zeigen.

## Sicherheit
Secrets gehören ausschließlich in Environment Variables. Berechtigungen werden serverseitig geprüft. Keine Passwörter, Tokens oder API-Keys gehören in das Repository.
