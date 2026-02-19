const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());

const API_SHN = 'https://www.hidro.gov.ar/api/v1/AlturasHorarias';
const URL_PRONOSTICO = 'http://www.hidro.gov.ar/oceanografia/pronostico.asp';

const ID_MAP = {
    'SFER': 'San Fernando',
    'BSAS': 'Buenos Aires',
    'LPLA': 'La Plata',
    'MDPL': 'Mar del Plata',
    'PTBL': 'Puerto Belgrano',
    'OYAR': 'Oyarvide',
    'PNOR': 'Pilote Norden',
    'ATAL': 'Atalaya'
};

app.get('/api/mareas', async (req, res) => {
    console.log("--- INICIANDO FUSIÓN METEOROLÓGICA ---");
    try {
        // 1. Peticiones simultáneas (API Base + Pronóstico Web)
        const [respApi, respPron] = await Promise.all([
            axios.get(API_SHN, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 10000 }),
            axios.get(URL_PRONOSTICO, { responseType: 'arraybuffer', timeout: 10000 }).catch(() => null)
        ]);

        // 2. Extraer Picos de Pronóstico Corregido
        const picosCorregidos = {}; 
        if (respPron) {
            const htmlPron = new TextDecoder('iso-8859-1').decode(respPron.data);
            const docPron = new JSDOM(htmlPron).window.document;
            const tables = Array.from(docPron.querySelectorAll('table'));

            tables.forEach(table => {
                const rows = Array.from(table.querySelectorAll('tr'));
                let currentPort = null;

                rows.forEach(row => {
                    const textoFila = row.textContent.toUpperCase();
                    // Detectar de qué puerto estamos leyendo
                    Object.values(ID_MAP).forEach(nombrePuerto => {
                        if (textoFila.includes(nombrePuerto.toUpperCase())) currentPort = nombrePuerto;
                    });

                    if (currentPort) {
                        const cells = Array.from(row.querySelectorAll('td'));
                        if (cells.length >= 4) {
                            const horaText = cells[2]?.textContent.trim(); // Ej: 14:30
                            const altText = cells[3]?.textContent.trim().replace(',', '.'); // Ej: 1.50
                            
                            if (horaText && horaText.match(/\d{2}:\d{2}/) && !isNaN(parseFloat(altText))) {
                                if (!picosCorregidos[currentPort]) picosCorregidos[currentPort] = [];
                                
                                // Crear objeto Date para el pico (asumiendo hoy o mañana)
                                const [h, m] = horaText.split(':').map(Number);
                                const fPico = new Date();
                                fPico.setHours(h, m, 0, 0);
                                if (fPico < new Date()) fPico.setDate(fPico.getDate() + 1); // Si ya pasó la hora, es de mañana

                                picosCorregidos[currentPort].push({
                                    hora: horaText,
                                    fecha: fPico,
                                    altura: parseFloat(altText)
                                });
                            }
                        }
                    }
                });
            });
            console.log("Picos meteorológicos encontrados:", Object.keys(picosCorregidos).length, "puertos");
        }

        // 3. Procesar API Base y Aplicar Correcciones
        const geoJson = typeof respApi.data === 'string' ? JSON.parse(respApi.data) : respApi.data;
        const data = [];

        if (geoJson.features) {
            geoJson.features.forEach(feature => {
                const id = feature.id || (feature.properties && feature.properties.id);
                const props = feature.properties;
                const nombrePuerto = ID_MAP[id];
                
                if (nombrePuerto && props) {
                    const currentVal = props.lectura;
                    const fechaStr = props.fecha;
                    let lastTime = "Reciente";
                    let lastDateObj = new Date();

                    if (fechaStr) {
                        lastDateObj = new Date(fechaStr);
                        const hh = String(lastDateObj.getHours()).padStart(2, '0');
                        const mm = String(lastDateObj.getMinutes()).padStart(2, '0');
                        lastTime = `${hh}:${mm}`;
                    }

                    // A. Extraer Curva Astronómica Base
                    let astroCurva = [];
                    if (props.astronomica) {
                        const startIndex = props.astronomica.findIndex(item => item[0] === fechaStr);
                        const datosDesdeAhora = startIndex !== -1 ? props.astronomica.slice(startIndex) : props.astronomica.filter(item => item[0] >= fechaStr);
                        astroCurva = datosDesdeAhora.slice(0, 25).map(item => item[1]);
                    }
                    while (astroCurva.length < 25) astroCurva.push(astroCurva[astroCurva.length - 1] || currentVal);

                    // B. MATEMÁTICA DE CORRECCIÓN (Desfasaje)
                    let curvaCorregida = [...astroCurva];
                    
                    if (currentVal !== null) {
                        // Desfasaje Actual (¿Cuánto está influyendo el clima AHORA?)
                        const offsetActual = currentVal - astroCurva[0];
                        
                        // Buscar el próximo pico corregido para este puerto
                        const picos = picosCorregidos[nombrePuerto] || [];
                        // Ordenar por cercanía en el tiempo
                        picos.sort((a, b) => a.fecha - b.fecha);
                        const proximoPico = picos.find(p => p.fecha > lastDateObj);

                        let offsetFuturo = offsetActual; // Por defecto mantenemos el error actual
                        let horasAlPico = 6; // Por defecto la inercia climática dura ~6 horas

                        if (proximoPico) {
                            horasAlPico = (proximoPico.fecha - lastDateObj) / (1000 * 60 * 60);
                            
                            // Buscar qué valor astronómico tendríamos en ese momento exacto
                            const idxAstro = Math.floor(horasAlPico);
                            const fraccion = horasAlPico - idxAstro;
                            let astroEnPico = astroCurva[0];
                            if (idxAstro < 24) {
                                // Interpolación lineal para sacar el valor exacto de la curva astronómica en el momento del pico
                                astroEnPico = astroCurva[idxAstro] + (astroCurva[idxAstro+1] - astroCurva[idxAstro]) * fraccion;
                            }
                            
                            // Desfasaje Futuro (¿Cuánto va a influir el clima en el PICO?)
                            offsetFuturo = proximoPico.altura - astroEnPico;
                        } else {
                            // Si no hay pronóstico (ej. Mar del Plata), asumimos que el error actual se desvanece suavemente a 0 en 12 horas
                            offsetFuturo = 0;
                            horasAlPico = 12;
                        }

                        // C. Aplicar la corrección punto por punto
                        curvaCorregida = astroCurva.map((valAstro, idx) => {
                            let peso = idx / horasAlPico;
                            if (peso > 1) peso = 1; // Si pasamos del pico, mantenemos el offset futuro
                            
                            // Suavizado coseno para que la transición sea orgánica (sin picos rectos)
                            const suavizado = (1 - Math.cos(peso * Math.PI)) / 2;
                            
                            const offsetInterpolado = offsetActual + (offsetFuturo - offsetActual) * suavizado;
                            return parseFloat((valAstro + offsetInterpolado).toFixed(2));
                        });
                        
                        // Asegurar que el punto 0 es exactamente el valor actual
                        curvaCorregida[0] = currentVal;
                    }

                    data.push({
                        estacion: nombrePuerto,
                        altura: currentVal !== null ? currentVal : 0,
                        hora: lastTime,
                        curva: curvaCorregida
                    });
                }
            });
        }

        res.json({ status: "ok", source: "API + Corrección Meteorológica", data: data });

    } catch (error) {
        console.error("ERROR CRÍTICO:", error.message);
        res.status(500).json({ error: "Fallo Scraper", details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listo en ${PORT}`));
