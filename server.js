const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());

const SHN_URL = 'https://www.hidro.gov.ar/oceanografia/alturashorarias.asp';

app.get('/api/mareas', async (req, res) => {
    console.log("--- INICIANDO SCRAPER V4 (INSPECTOR) ---");
    try {
        const response = await axios.get(SHN_URL, {
            responseType: 'arraybuffer',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36' 
            }
        });

        const htmlText = new TextDecoder('iso-8859-1').decode(response.data);
        const dom = new JSDOM(htmlText);
        const doc = dom.window.document;

        const data = [];
        const rows = Array.from(doc.querySelectorAll('tr'));
        console.log(`Filas totales en la tabla: ${rows.length}`);

        // 1. BUSCAR LA CABECERA DE HORAS
        // Estrategia: Buscamos la fila que tenga muchas horas (XX:XX)
        let times = ["Reciente"];
        const headerRow = rows.find(r => {
            // Contamos cuántos patrones de hora hay en la fila
            const matches = r.textContent.match(/\d{2}:\d{2}/g);
            return matches && matches.length > 3; // Si tiene más de 3 horas, es la cabecera
        });

        if (headerRow) {
            const matches = headerRow.textContent.match(/\d{2}:\d{2}/g);
            if (matches) {
                times = matches;
                console.log("Horarios detectados:", times);
            }
        } else {
            console.log("⚠️ No se detectó fila de horarios, usando hora genérica.");
        }

        // 2. BUSCAR LOS DATOS POR ATRIBUTO 'data-nombre'
        // Gracias a tu captura, sabemos que el nombre está en un atributo data-nombre
        // Lista de IDs que usa el SHN en su HTML (según inspección)
        const targets = [
            { id: 'San Fernando', name: 'SAN FERNANDO' },
            { id: 'Buenos Aires', name: 'BUENOS AIRES' },
            { id: 'La Plata', name: 'LA PLATA' },
            { id: 'Mar del Plata', name: 'MAR DEL PLATA' },
            { id: 'Puerto Belgrano', name: 'PUERTO BELGRANO' }, // A veces es "Belgrano" a secas
            { id: 'Oyarvide', name: 'OYARVIDE' }
        ];

        // Recorremos todas las filas buscando el enlace con el data-nombre
        rows.forEach(row => {
            const link = row.querySelector('a[data-nombre]');
            
            if (link) {
                const shnName = link.getAttribute('data-nombre');
                
                // Verificamos si es uno de los puertos que queremos
                // Usamos 'includes' porque a veces dice "Puerto Belgrano" y buscamos "Belgrano"
                const target = targets.find(t => shnName.includes(t.id) || t.id.includes(shnName));

                if (target) {
                    // ¡ENCONTRAMOS LA FILA!
                    // Ahora buscamos los valores en las celdas siguientes
                    const cells = Array.from(row.querySelectorAll('td'));
                    
                    // Empezamos desde el índice 1 (el 0 es el nombre)
                    for (let i = 1; i < cells.length; i++) {
                        // Limpieza: " 1.70 " -> "1.70"
                        const rawText = cells[i].textContent.trim();
                        
                        // Si la celda está vacía o tiene guiones, saltamos
                        if (!rawText || rawText === '-' || rawText === '') continue;

                        const val = parseFloat(rawText.replace(',', '.'));

                        if (!isNaN(val)) {
                            // Validar que no sea un número absurdo (ej: fecha)
                            if (val < 20) { 
                                // Asignamos la hora correspondiente a la columna (si existe)
                                // Ajustamos índice: la columna de datos 1 corresponde a la hora 0 (porque la col 0 es nombres)
                                const horaIndex = i - 1; 
                                const horaReal = times[horaIndex] || times[0] || "Reciente";

                                data.push({
                                    estacion: target.name,
                                    altura: val,
                                    hora: horaReal
                                });
                                console.log(`✅ ${target.name}: ${val}m (${horaReal})`);
                                break; // Ya tenemos el último dato, pasamos al siguiente puerto
                            }
                        }
                    }
                }
            }
        });

        console.log(`Extracción finalizada. ${data.length} estaciones encontradas.`);
        res.json({ status: "ok", data: data });

    } catch (error) {
        console.error("ERROR CRÍTICO:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server corriendo en ${PORT}`));
