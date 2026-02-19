const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');
const cron = require('node-cron'); // NUEVO: El reloj despertador

const app = express();
app.use(cors());

// --- CONFIGURACIÓN DE APIS ---
const API_SHN = 'https://www.hidro.gov.ar/api/v1/AlturasHorarias';
const URL_PRONOSTICO = 'http://www.hidro.gov.ar/oceanografia/pronostico.asp';

// --- TUS CREDENCIALES DE TELEGRAM ---
const TELEGRAM_TOKEN = '8477421452:AAFSsg_sUrbjTzq3cXN5sj72b7DkPUP9LIQ';
const TELEGRAM_CHAT_ID = '8500014412';

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

// ==========================================
// 1. FUNCIÓN PRINCIPAL: MAPA Y SLIDER
// ==========================================
app.get('/api/mareas', async (req, res) => {
    console.log("--- LECTURA DE MAREAS (USUARIO EN LA WEB) ---");
    try {
        const [respApi, respPron] = await Promise.all([
            axios.get(API_SHN, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 10000 }),
            axios.get(URL_PRONOSTICO, { responseType: 'arraybuffer', timeout: 10000 }).catch(() => null)
        ]);

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
                    Object.values(ID_MAP).forEach(nombrePuerto => {
                        if (textoFila.includes(nombrePuerto.toUpperCase())) currentPort = nombrePuerto;
                    });
                    if (currentPort) {
                        const cells = Array.from(row.querySelectorAll('td'));
                        if (cells.length >= 4) {
                            const horaText = cells[2]?.textContent.trim();
                            const altText = cells[3]?.textContent.trim().replace(',', '.');
                            if (horaText && horaText.match(/\d{2}:\d{2}/) && !isNaN(parseFloat(altText))) {
                                if (!picosCorregidos[currentPort]) picosCorregidos[currentPort] = [];
                                const [h, m] = horaText.split(':').map(Number);
                                const fPico = new Date();
                                fPico.setHours(h, m, 0, 0);
                                if (fPico < new Date()) fPico.setDate(fPico.getDate() + 1);
                                picosCorregidos[currentPort].push({ hora: horaText, fecha: fPico, altura: parseFloat(altText) });
                            }
                        }
                    }
                });
            });
        }

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

                    let astroCurva = [];
                    if (props.astronomica) {
                        const startIndex = props.astronomica.findIndex(item => item[0] === fechaStr);
                        const datosDesdeAhora = startIndex !== -1 ? props.astronomica.slice(startIndex) : props.astronomica.filter(item => item[0] >= fechaStr);
                        astroCurva = datosDesdeAhora.slice(0, 25).map(item => item[1]);
                    }
                    while (astroCurva.length < 25) astroCurva.push(astroCurva[astroCurva.length - 1] || currentVal);

                    let curvaCorregida = [...astroCurva];
                    if (currentVal !== null) {
                        const offsetActual = currentVal - astroCurva[0];
                        const picos = picosCorregidos[nombrePuerto] || [];
                        picos.sort((a, b) => a.fecha - b.fecha);
                        const proximoPico = picos.find(p => p.fecha > lastDateObj);

                        let offsetFuturo = offsetActual; 
                        let horasAlPico = 6; 

                        if (proximoPico) {
                            horasAlPico = (proximoPico.fecha - lastDateObj) / (1000 * 60 * 60);
                            const idxAstro = Math.floor(horasAlPico);
                            const fraccion = horasAlPico - idxAstro;
                            let astroEnPico = astroCurva[0];
                            if (idxAstro < 24) astroEnPico = astroCurva[idxAstro] + (astroCurva[idxAstro+1] - astroCurva[idxAstro]) * fraccion;
                            offsetFuturo = proximoPico.altura - astroEnPico;
                        } else {
                            offsetFuturo = 0;
                            horasAlPico = 12;
                        }

                        curvaCorregida = astroCurva.map((valAstro, idx) => {
                            let peso = idx / horasAlPico;
                            if (peso > 1) peso = 1; 
                            const suavizado = (1 - Math.cos(peso * Math.PI)) / 2;
                            const offsetInterpolado = offsetActual + (offsetFuturo - offsetActual) * suavizado;
                            return parseFloat((valAstro + offsetInterpolado).toFixed(2));
                        });
                        curvaCorregida[0] = currentVal;
                    }

                    data.push({ estacion: nombrePuerto, altura: currentVal !== null ? currentVal : 0, hora: lastTime, curva: curvaCorregida });
                }
            });
        }
        res.json({ status: "ok", source: "API + Corrección Meteorológica", data: data });
    } catch (error) {
        console.error("ERROR CRÍTICO:", error.message);
        res.status(500).json({ error: "Fallo Scraper", details: error.message });
    }
});


// ==========================================
// 2. SISTEMA DE ALERTAS (TELEGRAM BOT)
// ==========================================

async function enviarTelegram(mensaje) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: mensaje, parse_mode: 'HTML' });
        console.log("✅ Mensaje de Telegram enviado a Rodolfo!");
    } catch (error) {
        console.error("❌ Error enviando Telegram:", error.message);
    }
}

async function chequearMareaBasica(puertoID) {
    try {
        const response = await axios.get(API_SHN, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 10000 });
        const geoJson = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        const estacion = geoJson.features?.find(f => f.id === puertoID || (f.properties && f.properties.id === puertoID));
        return estacion ? estacion.properties : null;
    } catch (e) { return null; }
}

// ⏰ ALERTA CLUB: Martes, Miércoles y Viernes a las 15:00 hs
// Zona horaria de Buenos Aires para evitar errores de UTC de Render
cron.schedule('0 15 * * 2,3,5', async () => {
    console.log("Ejecutando revisión de marea para el Club...");
    const datos = await chequearMareaBasica('SFER'); 
    
    if (datos && datos.astronomica) {
        // Ajustamos la fecha de búsqueda al uso horario correcto
        const hoy = new Date().toLocaleString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" }).split(' ')[0];
        let mareaAltaDetectada = false;
        let picoMaximo = 0;

        datos.astronomica.forEach(item => {
            const fechaDato = item[0]; 
            const altura = item[1];
            
            if (fechaDato.includes(hoy)) {
                const hora = parseInt(fechaDato.split('T')[1].split(':')[0]); 
                // CRITERIO: Entre 18h y 21h, mayor a 1.50m
                if (hora >= 18 && hora <= 21 && altura >= 1.50) {
                    mareaAltaDetectada = true;
                    if (altura > picoMaximo) picoMaximo = altura;
                }
            }
        });

        if (mareaAltaDetectada) {
            enviarTelegram(`🚨 <b>¡Atención Entrenamiento TBC!</b>\nHoy la marea estará alta (Pico de ${picoMaximo}m entre las 18h y 21h).\n\n🚗 <i>Acordate de estacionar lejos del agua.</i>`);
        }
    }
}, { timezone: "America/Argentina/Buenos_Aires" });


// ⏰ ALERTA REMO: Sábados a las 08:00 hs
cron.schedule('0 8 * * 6', async () => {
    console.log("Ejecutando revisión de marea para Remar...");
    const datos = await chequearMareaBasica('SFER'); 
    
    if (datos && datos.astronomica) {
        const hoy = new Date().toLocaleString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" }).split(' ')[0];
        let horariosOptimos = [];

        datos.astronomica.forEach(item => {
            const fechaDato = item[0];
            const altura = item[1];
            
            if (fechaDato.includes(hoy)) {
                const horaCompleta = fechaDato.split('T')[1]; 
                // CRITERIO: Marea entre 1.00m y 1.40m
                if (altura >= 1.00 && altura <= 1.40) {
                    horariosOptimos.push(`${horaCompleta} hs -> ${altura}m`);
                }
            }
        });

        if (horariosOptimos.length > 0) {
            let mensaje = `🚣‍♂️ <b>¡Está lindo para salir a remar!</b>\nLa marea en Tigre/San Fernando estará en altura óptima hoy en estos horarios:\n\n`;
            horariosOptimos.forEach(h => mensaje += `✅ ${h}\n`);
            enviarTelegram(mensaje);
        } else {
            enviarTelegram(`🚣‍♂️ <i>Aviso de Remo: Hoy los niveles de marea no parecen los ideales (fuera del rango 1.00m - 1.40m). Revisá el mapa antes de salir.</i>`);
        }
    }
}, { timezone: "America/Argentina/Buenos_Aires" });

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listo en ${PORT} con Alertas de Telegram Activadas`));
