# ISS Lunar Transit Finder

Pagina web statica e gratuita per cercare possibili transiti della Stazione Spaziale Internazionale davanti alla Luna nei 30 giorni successivi.

## Funzioni

- coordinate manuali o geolocalizzazione del browser;
- raggio di ricerca configurabile fino a 20 km;
- TLE aggiornati della ISS da CelesTrak;
- aggiornamento automatico dell'orbita ogni due ore tramite GitHub Actions;
- propagazione SGP4 nel browser con `satellite.js`;
- posizione topocentrica della Luna con Astronomy Engine;
- ora locale, altezza, azimut, ascensione retta e declinazione;
- coordinate del punto di osservazione migliore;
- collegamento Google Maps ed esportazione calendario;
- nessun server, account o API a pagamento.

## Pubblicazione con GitHub Pages

1. Creare un repository pubblico chiamato `ISS-Lunar-Transit-Finder`.
2. Caricare l'intero contenuto del progetto, incluse le cartelle `data` e `.github`.
3. Aprire **Settings → Pages**.
4. In **Build and deployment**, scegliere **Deploy from a branch**.
5. Selezionare branch `main`, cartella `/ (root)` e premere **Save**.

La pagina sarà disponibile all'indirizzo:

`https://TUO-USERNAME.github.io/ISS-Lunar-Transit-Finder/`

## Avvertenza importante

Una previsione a 30 giorni serve per pianificare. Aggiornare sempre il calcolo 48 ore prima e il giorno stesso dell'evento. Le manovre orbitali e la resistenza atmosferica possono spostare la fascia del transito.

Questo progetto non garantisce l'osservabilità e non sostituisce una verifica con un secondo servizio indipendente.

## Licenza

MIT.
