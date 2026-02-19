const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// URL DE LA API OFICIAL
const API_URL = 'https://www.hidro.gov.ar/api/v1/AlturasHorarias';

// MAPEO DE IDs (Tu app usa nombres, la API usa IDs como 'SFER')
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
    console.log("--- CONSUMIENDO API OFICIAL SHN ---");
    try {
        // 1. Petición a la API Oficial
        // Usamos headers de navegador para evitar bloqueos
        const response = await axios.get(API_URL, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json' 
            },
            timeout: 10000 // Timeout de 10s
        });

        // Aseguramos que sea objeto JSON
        const geoJson = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        const data = [];

        // 2. Procesar Features
        if (geoJson.features && Array.isArray(geoJson.features)) {
            
            geoJson.features.forEach(feature => {
                const props = feature.properties;
                const id = feature.id; // Ej: "SFER"
                
                // Solo procesamos los puertos que nos interesan (definidos en ID_MAP)
                if (ID_MAP[id]) {
                    
                    // A. DATO REAL ACTUAL
                    // props.lectura tiene el último valor (ej: 1.64)
                    // props.fecha tiene la hora ISO (ej: "2026-02-18T23:45")
                    const currentVal = props.lectura;
                    let lastTime = "Reciente";
                    let lastDateObj = new Date(); // Fecha base para filtrar futuro

                    if (props.fecha) {
                        lastDateObj = new Date(props.fecha);
                        // Formateamos la hora a HH:MM para el frontend
                        const hh = String(lastDateObj.getHours()).padStart(2, '0');
                        const mm = String(lastDateObj.getMinutes()).padStart(2, '0');
                        lastTime = `${hh}:${mm}`;
                    }

                    // B. CURVA FUTURA (ASTRONÓMICA)
                    // props.astronomica es un array de arrays: [ ["2026-02-19T00:45", 1.25], ... ]
                    let curvaFutura = [];
                    
                    if (props.astronomica && Array.isArray(props.astronomica)) {
                        // Filtramos para quedarnos solo con el FUTURO (datos después de la fecha actual)
                        const datosFuturos = props.astronomica.filter(item => {
                            const fechaItem = new Date(item[0]);
                            return fechaItem > lastDateObj;
                        });

                        // Extraemos solo los valores de altura para el slider
                        // Tomamos hasta 25 horas hacia adelante
                        curvaFutura = datosFuturos.slice(0, 25).map(item => item[1]);
                    }

                    // Si no hay datos futuros suficientes, rellenamos con el último valor conocido (fallback)
                    if (curvaFutura.length < 25) {
                        const ultimoValor = curvaFutura.length > 0 ? curvaFutura[curvaFutura.length-1] : (currentVal || 0);
                        while(curvaFutura.length < 25) {
                            curvaFutura.push(ultimoValor);
                        }
                    }

                    // Solo agregamos si tenemos dato real (o null si está roto el sensor, pero enviamos estructura igual)
                    data.push({
                        estacion: ID_MAP[id], // Nombre legible (San Fernando)
                        id_shn: id,           // ID técnico (SFER)
                        altura: currentVal !== null ? currentVal : 0, // Altura real
                        hora: lastTime,       // Hora real (HH:MM)
                        curva: curvaFutura    // Array de predicciones futuras
                    });
                    
                    console.log(`✅ ${ID_MAP[id]} (${id}): ${currentVal}m a las ${lastTime}`);
                }
            });
        }

        res.json({ status: "ok", source: "SHN API Oficial", data: data });

    } catch (error) {
        console.error("ERROR CRÍTICO:", error.message);
        res.status(500).json({ error: "Error conectando a API SHN", details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server corriendo en puerto ${PORT}`));
