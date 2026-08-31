# LOELSTI

Eigenständige Echtzeit-Kommunikationsplattform. Diese Repository-Struktur bildet die produktionsfähige Grundlage für Web/PWA, API, Authentifizierung, persistente Daten und Realtime-Kommunikation. Die Web-App enthält ein installierbares PWA-Manifest, ein eigenes App-Icon und einen Offline-App-Shell-Service-Worker.

## Struktur
- `apps/web` – React/TypeScript/Vite Frontend
- `apps/api` – Node/TypeScript API + Socket.IO
- `packages` – später gemeinsam nutzbare UI-/Typ-/SDK-Pakete
- `prisma` – Datenmodell und Migrationen im API-Workspace

## Lokal
1. `.env.example` nach `.env` kopieren.
2. `npm install`
3. PostgreSQL starten (`docker compose up -d postgres`)
4. `npm run db:migrate --workspace apps/api`
5. `npm run dev`

## Sicherheitsgrundsätze
Secrets gehören ausschließlich in Environment Variables. Berechtigungen werden serverseitig geprüft. Nachrichten, Server, Rollen und Einstellungen werden persistent gespeichert; Demo-Seeds sind nur für Entwicklung vorgesehen.
