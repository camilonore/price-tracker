# Rastreador de precios

HTML + CSS + JavaScript puro. Vite solo instala y empaqueta dependencias.

    npm install
    npm run dev
    npm run build

Dependencias gratuitas: vite, chart.js, tesseract.js, firebase, @fontsource.

## Firebase (una sola vez)
1. Consola de Firebase > proyecto viajes-a42b3 > Build > Firestore Database > Crear base de datos.
2. Pestaña Reglas. Para empezar a usarla (acceso abierto a quien conozca el proyecto):

    rules_version = '2';
    service cloud.firestore {
      match /databases/{database}/documents {
        match /price_tracker_products/{doc} {
          allow read, write: if true;
        }
      }
    }

Los datos van en la colección `price_tracker_products`, separada de lo demás del proyecto.
