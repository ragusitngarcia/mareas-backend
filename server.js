const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');
const cron = require('node-cron');

const app = express();
app.use(cors());

// --- CONFIGURACIÓN DE APIS (SHN + INA) ---
const API_SHN = 'https://www.hidro.gov.ar/api/v1/AlturasHorarias';
const URL_PRONOSTICO = 'http://www.hidro.gov.ar/oceanografia/pronostico.asp';
const API_INA = 'https://alerta.ina.gob.ar/pub/datos/datosProno?seriesId=26202&calId=432&all=false&siteCode=52&varId=2&format=json';

// --- CREDENCIALES DE TELEGRAM ---
const TELEGRAM_TOKEN = '8477421452:AAFSsg_sUrbjTzq3cXN5sj72b7DkPUP9LIQ';
const TELEGRAM_CHAT_ID = '-1003776128489';

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
    try {
        const [respApi, respPron, respIna] = await Promise.all([
            axios.get(API_SHN, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 10000 }),
            axios.get(URL_PRONOSTICO, { responseType: 'arraybuffer', timeout: 10000 }).catch(() => null),
            axios.get(`${API_INA}&timeStart=now-1days&timeEnd=now+4days`, { timeout: 10000 }).catch(() => null)
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

        let curvaINA = [];
        if (respIna && respIna.data && Array.isArray(respIna.data)) {
            curvaINA = respIna.data.map(item => ({
                fecha: new Date(item.time_start || item.time),
                altura: parseFloat(item.valor || item.value)
            })).sort((a, b) => a.fecha - b.fecha);
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
                        astroCurva = datosDesdeAhora.slice(0, 72).map(item => item[1]);
                    }
                    while (astroCurva.length < 25) astroCurva.push(astroCurva[astroCurva.length - 1] || currentVal);

                    let curvaFinal = [...astroCurva];
                    
                    if (nombrePuerto === 'San Fernando' && curvaINA.length > 0) {
                        curvaFinal = astroCurva.map((valAstro, idx) => {
                            const horaBuscada = new Date(lastDateObj.getTime() + (idx * 60 * 60 * 1000));
                            const datoInaCercano = curvaINA.find(d => Math.abs(d.fecha - horaBuscada) < 1800000); 
                            if (datoInaCercano) return parseFloat(datoInaCercano.altura.toFixed(2));
                            return valAstro; 
                        });
                        curvaFinal[0] = currentVal;
                    } else if (currentVal !== null) {
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

                        curvaFinal = astroCurva.map((valAstro, idx) => {
                            let peso = idx / horasAlPico;
                            if (peso > 1) peso = 1; 
                            const suavizado = (1 - Math.cos(peso * Math.PI)) / 2;
                            const offsetInterpolado = offsetActual + (offsetFuturo - offsetActual) * suavizado;
                            return parseFloat((valAstro + offsetInterpolado).toFixed(2));
                        });
                        curvaFinal[0] = currentVal;
                    }

                    data.push({ estacion: nombrePuerto, altura: currentVal !== null ? currentVal : 0, hora: lastTime, curva: curvaFinal });
                }
            });
        }
        res.json({ status: "ok", source: "SHN + Modelo INA", data: data });
    } catch (error) {
        console.error("ERROR CRÍTICO:", error.message);
        res.status(500).json({ error: "Fallo Scraper/APIs", details: error.message });
    }
});

// ==========================================
// 2. SISTEMA DE ALERTAS (TELEGRAM BOT)
// ==========================================
async function enviarTelegram(mensaje) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: mensaje, parse_mode: 'HTML' });
        console.log("✅ Mensaje de Telegram enviado al Canal!");
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

// LÓGICA DE ALERTAS INTELIGENTES
function generarTextoAlertas(maxAltura, minAltura) {
    let alertasExtra = "";
    
    // Prioridad Alta (Inundación)
    if (maxAltura >= 2.40) {
        alertasExtra += `🚨 <b>MAREA EXTREMA:</b> NO ESTACIONAR CERCA DEL TBC.\n`;
    } else if (maxAltura >=
