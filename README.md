# Turnario

Turni mensili automatici per hotel e ristoranti, con scambi tra colleghi ("vince il primo che accetta").

## Struttura
- `index.html`: il sito (un solo file), pubblicato con GitHub Pages. È già collegato al progetto Supabase `turnario`.
- `supabase/functions/api/`: funzione server (Edge Function `api`) con tutta la logica:
  - `logic.js`: generazione turni, ricerca scambi, controllo regole (riposo minimo, giorni di fila)
  - `index.ts`: login/registrazione, personale, richieste, accettazione atomica, notifiche ed email

## Pubblicazione
Il sito è pubblicato con GitHub Pages dal branch `main`: https://nicolomilan.github.io/turnario/
La funzione `calendar` fornisce a ogni dipendente un calendario in abbonamento (iPhone e Google Calendar).

## Email (Resend)
Le notifiche in app funzionano già. Per mandare anche le email:
1. Su Resend aggiungi e verifica un dominio (es. `tuohotel.it`).
2. In Supabase → Edge Functions → Secrets imposta:
   - `RESEND_API_KEY` = la chiave Resend
   - `EMAIL_FROM` = `Turnario <turni@tuohotel.it>`
   - `APP_URL` = l'indirizzo del sito pubblicato

## Sicurezza
- Il browser può solo **leggere** i dati della propria attività (RLS). Tutte le modifiche passano dalla funzione `api`, che controlla ruolo e regole.
- Gli account del personale li crea il responsabile, con password temporanea da cambiare al primo accesso.

## Limiti attuali
- Una richiesta di libero deve stare dentro un singolo mese (max 14 giorni).
