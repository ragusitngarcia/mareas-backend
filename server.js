const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());

// URLS OFICIALES
const URL_REAL = 'https://www.hidro.gov.ar/oceanografia/alturashorarias.asp';
const URL_PRONOSTICO = 'http://www.hidro.gov.ar/oceanografia/pronostico.asp';

app.get('/api/mareas', async (req, res) => {
    console.log("--- INICIANDO SCRAPER FUSIONADO (REAL + PRONÓSTICO) ---");
    try {
        // 1. OBTENER DATO REAL (AHORA)
        const respReal = await axios.get(URL_REAL, { responseType: 'arraybuffer' });
        const htmlReal = new TextDecoder('iso-8859-1').decode(respReal.data);
        const docReal = new JSDOM(htmlReal).window.document;
        
        // 2. OBTENER PRONÓSTICO (FUTURO)
        const respPron = await axios.get(URL_PRONOSTICO, { responseType: 'arraybuffer' });
        const htmlPron = new TextDecoder('iso-8859-1').decode(respPron.data);
        const docPron = new JSDOM(htmlPron).window.document;

        const data = [];
        const targets = [
            { id: 'SAN FERNANDO', name: 'SAN FERNANDO' },
            { id: 'BUENOS AIRES', name: 'BUENOS AIRES' },
            { id: 'LA PLATA', name: 'LA PLATA' },
            { id: 'MAR DEL PLATA', name: 'MAR DEL PLATA' },
            { id: 'BELGRANO', name: 'PUERTO BELGRANO' },
            { id: 'OYARVIDE', name: 'OYARVIDE' }
        ];

        // --- PROCESAR DATO REAL ---
        // Buscamos la hora de la columna 1 (la más reciente)
        let horaActualStr = "Reciente";
        const headerRow = Array.from(docReal.querySelectorAll('tr')).find(r => (r.textContent.match(/\d{2}:\d{2}/g) || []).length > 3);
        if (headerRow) {
            const matches = headerRow.textContent.match(/(\d{2}:\d{2})/g);
            if (matches && matches.length > 0) horaActualStr = matches[0];
        }

        // Procesar cada puerto
        for (const target of targets) {
            // A. BUSCAR VALOR ACTUAL
            let currentVal = null;
            const rowsReal = Array.from(docReal.querySelectorAll('tr'));
            
            // Buscar fila por data-nombre (método preciso) o texto
            const rowReal = rowsReal.find(r => {
                const link = r.querySelector('a[data-nombre]');
                if (link && link.getAttribute('data-nombre').toUpperCase().includes(target.id)) return true;
                return r.textContent.toUpperCase().includes(target.id);
            });

            if (rowReal) {
                const cells = Array.from(rowReal.querySelectorAll('td'));
                // Intentamos leer la columna 1 (dato más nuevo)
                // Ojo: cells[0] es el nombre, cells[1] es el dato #1
                for(let i=1; i<cells.length; i++) {
                     let val = parseFloat(cells[i].textContent.replace(',', '.'));
                     if (!isNaN(val) && val < 20) {
                         currentVal = val;
                         break;
                     }
                }
            }

            // Si no encontramos dato real, seguimos con el siguiente puerto
            if (currentVal === null) continue;

            // B. BUSCAR PRONÓSTICO FUTURO (Picos)
            // El pronóstico está en una tabla compleja. Buscamos filas que tengan el nombre o estén vacías justo debajo.
            let picos = [];
            
            // Tablas de pronóstico
            const tablesPron = Array.from(docPron.querySelectorAll('table'));
            let foundStation = false;

            tablesPron.forEach(table => {
                const rows = Array.from(table.querySelectorAll('tr'));
                rows.forEach(row => {
                    const txt = row.textContent.toUpperCase();
                    
                    // Si encontramos el nombre del puerto, activamos bandera
                    if (txt.includes(target.id)) {
                        foundStation = true;
                    } 
                    // Si encontramos otro puerto explícito, desactivamos (para no leer datos de otro)
                    else if (targets.some(t => t.id !== target.id && txt.includes(t.id))) {
                        foundStation = false;
                    }

                    if (foundStation) {
                        // Extraer Hora y Altura: Formato "PLEAMAR | 22:00 | 1.70"
                        const cells = Array.from(row.querySelectorAll('td'));
                        if (cells.length >= 4) {
                            const horaTxt = cells[2]?.textContent.trim(); // Ej: 22:00
                            const altTxt = cells[3]?.textContent.trim().replace(',', '.'); // Ej: 1.70
                            
                            if (horaTxt && horaTxt.match(/\d{2}:\d{2}/) && !isNaN(parseFloat(altTxt))) {
                                // Convertir hora texto a objeto fecha relativo a hoy
                                picos.push({ 
                                    hora: horaTxt, 
                                    altura: parseFloat(altTxt),
                                    tipo: cells[1]?.textContent.trim() // Pleamar/Bajamar
                                });
                            }
                        }
                    }
                });
            });

            // C. GENERAR CURVA (INTERPOLACIÓN)
            // Unimos el punto actual con los picos futuros usando una curva coseno
            const curva = generarCurvaConPicos(currentVal, horaActualStr, picos);

            data.push({
                estacion: target.name,
                altura: currentVal,
                hora: horaActualStr,
                curva: curva
            });
            console.log(`✅ ${target.name}: ${currentVal}m -> ${picos.length} picos futuros detectados.`);
        }

        res.json({ status: "ok", data: data });

    } catch (error) {
        console.error("ERROR CRÍTICO:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- MOTOR MATEMÁTICO ---
function generarCurvaConPicos(valActual, horaActualStr, picos) {
    const curva = [];
    const now = new Date();
    
    // Parsear hora actual del dato (ej "20:45")
    const [hNow, mNow] = horaActualStr.split(':').map(Number);
    const fechaDato = new Date();
    fechaDato.setHours(hNow, mNow, 0, 0);

    // Ajuste de fecha: si el dato dice 23:00 y son las 01:00, el dato es de ayer
    if (now.getHours() < hNow - 4) fechaDato.setDate(fechaDato.getDate() - 1);

    // Convertir picos a objetos Date
    const picosFechas = picos.map(p => {
        const [h, m] = p.hora.split(':').map(Number);
        const fecha = new Date(fechaDato);
        fecha.setHours(h, m, 0, 0);
        // Si la hora del pico es menor a la del dato, asumimos que es mañana
        if (fecha < fechaDato) fecha.setDate(fecha.getDate() + 1);
        return { fecha, altura: p.altura };
    }).sort((a, b) => a.fecha - b.fecha);

    // Generar 24 puntos (1 por hora)
    for (let i = 0; i <= 24; i++) {
        const tFuturo = new Date(fechaDato.getTime() + i * 60 * 60 * 1000); // +i horas
        
        // Encontrar entre qué picos estamos
        // Punto de partida por defecto: el dato actual
        let p1 = { fecha: fechaDato, altura: valActual };
        let p2 = picosFechas[0]; // Primer pico pronosticado

        // Buscar el segmento correcto
        for (let j = 0; j < picosFechas.length; j++) {
            if (tFuturo >= picosFechas[j].fecha) {
                p1 = picosFechas[j];
                p2 = picosFechas[j+1] || { 
                    // Si no hay más picos, inventamos uno siguiendo la inercia (marea semidiurna ~6h después)
                    fecha: new Date(picosFechas[j].fecha.getTime() + 6*3600*1000), 
                    altura: picosFechas[j].altura + (picosFechas[j].altura > 1 ? -0.8 : 0.8) 
                };
            } else {
                break; // Estamos antes de este pico, así que el segmento p1-p2 es válido
            }
        }

        // Interpolación Cosoidal (Suaviza la curva entre dos puntos)
        // t es el progreso entre p1 y p2 (0.0 a 1.0)
        if (p2 && p2.fecha > p1.fecha) {
            const totalDuracion = p2.fecha - p1.fecha;
            const transcurrido = tFuturo - p1.fecha;
            const t = Math.max(0, Math.min(1, transcurrido / totalDuracion));
            
            // Fórmula: interpolación coseno
            // (1 - cos(t * PI)) / 2  -> va de 0 a 1 suavemente
            const factor = (1 - Math.cos(t * Math.PI)) / 2;
            const alturaEstimada = p1.altura + (p2.altura - p1.altura) * factor;
            
            curva.push(parseFloat(alturaEstimada.toFixed(2)));
        } else {
            curva.push(valActual); // Fallback
        }
    }
    return curva;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server corriendo en ${PORT}`));
