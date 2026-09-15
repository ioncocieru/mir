# Mir — joc de cărți online

Site static (HTML/CSS/JS) pentru 2–5 jucători, sincronizat live printr-un
proiect gratuit **Supabase**. Se pune pe **GitHub** și se face deploy pe
**Vercel** — fără server propriu de scris.

## Regulile implementate

- Pachet de 36 de cărți (6 → 7 → 8 → 9 → 10 → J → Q → K → A, câte 4 din
  fiecare, 4 culori). **Tot pachetul se împarte de la început** — nu se
  mai trage nicio carte în timpul jocului (ce nu se împarte egal rămâne
  ca „rezervă" mică vizibilă pe masă, folosită doar la penalizări).
- Cine are **6 de inimă** deschide jocul, obligatoriu cu acea carte.
- Se joacă în ordinea locurilor. La rândul tău, fie pui o carte
  **egală sau mai mare** decât ultima de pe masă, fie apeși
  **„Iau cărțile"** — apoi **alegi tu câte cărți iei** (minim 4, sau
  tot ce e pe masă dacă sunt mai puține de 4), din **ultimele puse**;
  restul rămân scoase din joc.
- **Careu (4 cărți identice)**: dacă ai la tine toate cele 4 cărți de
  același fel (ex: toți cei 4 popi), poți apăsa **„🃏 Scoate careul"**
  oricând, ca să le scoți definitiv din joc — nu mai trebuie să le joci
  pe masă. Dacă asta îți golește mâna, ieși din rundă normal.
- Oricând poți apăsa **„🏁 Am terminat"**:
  - dacă chiar nu mai ai cărți, ieși din joc normal;
  - dacă minți (încă ai cărți), te retragi din rândul de joc, dar
    rămâi expus — oricine poate apăsa **„🔍 Verifică"** pe avatarul tău.
- **Verificare/acuzație**: orice jucător poate verifica pe oricine,
  oricând:
  - dacă cel verificat chiar mai avea cărți ascunse → e prins cu
    minciuna și primește **6 cărți penalizare** (întâi din rezerva de
    pe masă, apoi random de la ceilalți jucători dacă rezerva nu ajunge);
  - dacă acuzația era falsă (chiar nu mai avea cărți) → **cel care a
    acuzat** primește el cele 6 cărți penalizare.
- Cine rămâne singurul cu cărți în mână **pierde runda**; ceilalți
  primesc câte un punct („★" în bara de sus).
- **Pierderi (strikes)**: cine pierde o rundă primește un „strike"
  (afișat ca `2/3` lângă nume). La **a treia pierdere, jucătorul e
  eliminat definitiv din acest grup/cameră** — rămâne să vadă jocul și
  chatul, dar nu mai poate juca runde noi aici. Poate juca oricând
  într-o cameră nouă (cod nou).
- După fiecare rundă, dacă mai sunt cel puțin 2 jucători neeliminați,
  **runda următoare pornește automat** după 10 secunde (gazda poate
  apăsa și „Joacă din nou acum" ca să nu mai aștepte). Scorul și
  numărul de pierderi se păstrează între runde, în aceeași cameră.
- Fiecare jucător își alege un nume și o culoare de avatar (cerc cu
  inițiale) — vizibile tuturor la masă.
- Chat lateral cu emoji, vizibil tuturor din cameră; emojiurile trimise
  apar și ca reacții plutitoare pe ecran.

Dacă vrei alte ajustări (de ex. atac cu mai multe cărți deodată ca la
Durak clasic, sau o fereastră de timp limitată pentru verificare),
spune-mi și modific logica din `game.js`.

## 1. Baza de date (gratuit) — Supabase

Site-ul are nevoie de un loc unde să scrie/citească starea camerei de
joc în timp real. Am ales **Supabase** pentru că are un tier gratuit
generos (500MB bază de date, realtime inclus, fără card de credit la
înscriere) și e simplu de conectat dintr-un site static ca acesta.
Codul din `game.js` e deja scris să funcționeze cu Supabase — nu trebuie
să atingi nimic altceva în afară de `config.js`, la pasul 5.

**Pas cu pas:**

1. Intră pe **[supabase.com](https://supabase.com)** → „Start your project"
   → autentifică-te cu GitHub (cel mai rapid) sau email.
2. Apasă **„New project"**:
   - Alege un nume oricare (ex: `mir-joc`)
   - Setează o parolă pentru baza de date (nu contează care, nu o vei
     folosi direct)
   - Alege regiunea cea mai apropiată de tine (ex: Frankfurt pentru
     Europa)
   - Apasă „Create new project" și așteaptă ~1-2 minute cât se
     inițializează.
3. Din meniul din stânga, deschide **SQL Editor** → „New query" și
   lipește exact acest cod, apoi apasă „Run":

   ```sql
   create table rooms (
     code text primary key,
     state jsonb not null,
     updated_at timestamptz default now()
   );

   alter table rooms enable row level security;

   create policy "allow all read" on rooms for select using (true);
   create policy "allow all insert" on rooms for insert with check (true);
   create policy "allow all update" on rooms for update using (true);
   ```

   Ar trebui să vezi „Success. No rows returned" — înseamnă că tabela
   `rooms` a fost creată corect.
4. Activează sincronizarea live pentru tabela `rooms` — cel mai sigur
   mod, care funcționează indiferent cum arată interfața Supabase în
   momentul în care citești asta, e să rulezi în **SQL Editor** (același
   loc ca la pasul 3) încă o comandă:

   ```sql
   alter publication supabase_realtime add table rooms;
   ```

   Dacă preferi din interfață: meniul din stânga → **Database** →
   **Publications** → sub `supabase_realtime` → activează switch-ul
   pentru tabela `rooms`. (Atenție: NU e pagina „Replication" — aceea
   e pentru altceva, export de date către destinații externe. Dacă nu
   găsești „Publications" în meniu, comanda SQL de mai sus face exact
   același lucru și e cea mai sigură variantă.)
5. Ia cheile de conectare:
   - Meniul din stânga → **Project Settings** (iconița de rotiță, jos)
     → **API**
   - Copiază valoarea de la **„Project URL"** (arată cam așa:
     `https://abcdefghijk.supabase.co`)
   - Copiază valoarea de la **„anon public"** (sub „Project API keys" —
     e un șir lung de litere/cifre)
6. Deschide fișierul **`config.js`** din acest proiect și înlocuiește:

   ```js
   const SUPABASE_URL = "PUNE_AICI_URL_PROIECTULUI_TAU_SUPABASE";
   const SUPABASE_ANON_KEY = "PUNE_AICI_CHEIA_ANON_PUBLIC";
   ```

   cu valorile tale reale, între ghilimele, exact așa cum le-ai copiat.
   Salvează fișierul.

Asta e tot — nu mai trebuie să modifici nimic altceva legat de baza de
date. La pasul 2 și 3 de mai jos, urcă tot folderul (inclusiv
`config.js` completat) pe GitHub și apoi pe Vercel.

> **Notă despre securitate:** politicile SQL de mai sus permit oricui
> cu link-ul să citească/scrie camere — e suficient pentru un joc
> casual între prieteni, dar nu pune informații sensibile în numele de
> jucător sau în chat, pentru că tehnic sunt vizibile oricui ar avea
> cheia `anon` (care oricum e publică prin design la Supabase, nu e un
> secret real).

> **Dacă preferi altă bază de date gratuită** (de ex. Firebase Realtime
> Database), pot să-ți adaptez `game.js` să folosească Firebase în loc
> de Supabase — spune-mi și fac schimbarea. Ambele au tier gratuit
> suficient pentru un joc de cărți între prieteni.

## 2. Pune codul pe GitHub

```bash
cd mir-joc
git init
git add .
git commit -m "Primul commit — jocul Mir"
git branch -M main
git remote add origin https://github.com/<user-ul-tau>/mir-joc.git
git push -u origin main
```

## 3. Deploy pe Vercel

1. Intră pe [vercel.com](https://vercel.com), conectează-ți contul GitHub.
2. „Add New… → Project" → alege repo-ul `mir-joc`.
3. Framework Preset: **Other** (site static, nu are nevoie de build step).
4. Deploy. Vercel îți dă un link de tipul `mir-joc.vercel.app`.
5. La fiecare `git push`, Vercel redeployează automat.

## 4. Cum se joacă

1. Fiecare persoană deschide link-ul Vercel.
2. Primul scrie numele și apasă **„Creează o cameră"** → primește un cod
   (ex: `MIR-4821`) și îl trimite celorlalți.
3. Ceilalți scriu numele, introduc codul și apasă **„Intră în cameră"**.
4. Gazda apasă **„Începe jocul"** când sunt minim 2 jucători (maxim 5).

## Structura fișierelor

```
mir-joc/
├── index.html     — cele 4 ecrane: lobby, sală de așteptare, joc, final
├── style.css      — tema vizuală (masă verde, cărți, chat)
├── game.js        — toată logica jocului + sincronizare Supabase
├── config.js      — AICI pui URL-ul și cheia Supabase
└── README.md
```

## Limitări de care să știi

- Fiecare client validează și scrie starea jocului direct în Supabase
  (nu există un server-arbitru separat). E suficient de robust pentru
  o partidă între prieteni, dar un jucător cu cunoștințe tehnice ar putea
  teoretic trișa modificând starea direct din consolă. Dacă vrei o
  variantă anti-trișare (cu validare pe server, via Supabase Edge
  Functions), pot să ți-o construiesc separat.
- Dacă doi jucători acționează exact în aceeași secundă, ultimul scris
  „câștigă" (last-write-wins). Pentru un joc pe rânduri ca acesta, riscul
  e mic pentru că de obicei acționează o singură persoană pe rând.
