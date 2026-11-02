# Trasy prádelny

Plánování linek pro D&D laundry, Vidov: rozdělení zákazníků mezi auta, nejkratší pořadí zastávek, listy pro řidiče a odeslání linky přes WhatsApp.

Aplikace je jeden soubor `index.html`. Přihlašuje se e-mailem a heslem přes Supabase; data (auta, řidiči, zákazníci, linky) jsou uložená v databázi Supabase (region EU) a vidí je jen přihlášení uživatelé.

Nastavení databáze: spusťte `supabase.sql` v Supabase SQL Editoru. Uživatele zakládá správce v Supabase (Authentication → Users → Add user), registrace z aplikace není.

Používá bezplatné služby OpenStreetMap Nominatim (adresy), OSRM (trasy) a CARTO (mapa).
