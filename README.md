# LOELSTI

Eigenständige Echtzeit-Kommunikationsplattform mit Web/PWA-Grundlage, API und installierbarer App.

## Struktur
- `apps/web` – React + TypeScript + Vite Frontend; dieses Frontend läuft im Browser und wird auch direkt in der installierten LOELSTI-App verwendet
- `apps/api` – Node + TypeScript + Express + Socket.IO API
- `apps/desktop` – Tauri-2-Client
- `apps/download-site` – **die einzige öffentliche Download-Seite** mit ausschließlich Windows, iOS und Android
- `packages` – Platz für gemeinsam nutzbare UI-/Typ-/SDK-Pakete

## Grundregel der öffentlichen Seiten
Es gibt keine separate Produkt-, Release- oder Plattform-Auswahlseite. Die öffentliche Download-Seite enthält nur:

1. Download Windows
2. Download iOS
3. Download Android

Die installierte LOELSTI-App öffnet direkt das gebündelte `apps/web`-Frontend und nicht die Download-Seite.

## Lokal
1. `.env.example` nach `.env` kopieren.
2. `npm install`
3. PostgreSQL starten: `docker compose up -d postgres`
4. Datenbank migrieren: `npm run db:migrate`
5. Web + API starten: `npm run dev`
6. Desktop-App im Entwicklungsmodus starten: `npm run desktop:dev`

## Desktop-App bauen
`npm run desktop:build`

Der Tauri-Client bündelt das gebaute `apps/web`-Frontend in einer eigenen LOELSTI-App. Die App ist deshalb von der öffentlichen Download-Seite getrennt.

## Releases
Desktop-Releases werden über Tags im Format `desktop-v*` veröffentlicht. Die veröffentlichte Download-Seite sucht die passenden Release-Dateien automatisch anhand ihrer Dateiendungen. Windows nutzt EXE/MSI, Android APK und iOS IPA, sofern diese Artefakte tatsächlich veröffentlicht wurden.

## API-Konfiguration
Die Desktop- und Web-App verwenden `VITE_API_URL` zur Auswahl der LOELSTI-API. Für eine veröffentlichte App muss diese Variable beim Build auf die produktive API zeigen.

## Sicherheit
Secrets gehören ausschließlich in Environment Variables. Berechtigungen werden serverseitig geprüft. Keine Passwörter, Tokens oder API-Keys gehören in das Repository.
