const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// URL OFICIAL API V1
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
    console.log("--- CONSUMIENDO API OFICIAL (MODO ALINEADO) ---");
    try {
        const response = await axios.get(API_URL, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json' 
            },
            timeout: 10000 
        });

        const geoJson = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        const data = [];

        if (geoJson.features && Array.isArray(geoJson.features)) {
            
            geoJson.features.forEach(feature => {
                // El ID viene en la raíz del feature (ej: "SFER") o en properties (a veces)
                const id = feature.id || (feature.properties && feature.properties.id);
                const props = feature.properties;
                
                if (ID_MAP[id] && props) {
                    
                    // 1. DATO REAL (LECTURA)
                    const currentVal = props.lectura; // Ej: 1.64
                    const fechaStr = props.fecha;     // Ej: "2026-02-18T23:45"
                    
                    let lastTime = "Reciente";
                    
                    if (fechaStr) {
                        const dateObj = new Date(fechaStr);
                        // Extraemos la hora HH:MM para mostrar en el frontend
                        const hh = String(dateObj.getHours()).padStart(2, '0');
                        const mm = String(dateObj.getMinutes()).padStart(2, '0');
                        lastTime = `${hh}:${mm}`;
                    }

                    // 2. CURVA ASTRONÓMICA (FUTURO)
                    let curvaFutura = [];

                    if (props.astronomica && Array.isArray(props.astronomica) && fechaStr) {
                        
                        // ALINEACIÓN CLAVE: 
                        // Buscamos el índice exacto donde la fecha coincide con la del dato real.
                        // Así curva[0] será la astronómica de "AHORA" (23:45)
                        // y curva[1] será la astronómica de "+1h" (00:45) -> 1.25m
                        
                        const startIndex = props.astronomica.findIndex(item => item[0] === fechaStr);

                        let datosDesdeAhora = [];
                        if (startIndex !== -1) {
                            // Si encontramos la hora exacta, cortamos el array desde ahí
                            datosDesdeAhora = props.astronomica.slice(startIndex);
                        } else {
                            // Fallback: Si por algo no coinciden los segundos, buscamos >= fecha
                            datosDesdeAhora = props.astronomica.filter(item => item[0] >= fechaStr);
                        }

                        // Mapeamos solo a alturas (el frontend ya sabe calcular las horas)
                        // Tomamos 25 puntos (0 a 24 horas)
                        curvaFutura = datosDesdeAhora.slice(0, 25).map(item => item[1]);
                    }

                    // Relleno de seguridad por si faltan datos al final del array
                    if (curvaFutura.length < 25) {
                        const ultimo = curvaFutura.length > 0 ? curvaFutura[curvaFutura.length - 1] : (currentVal || 0);
                        while (curvaFutura.length < 25) {
                            curvaFutura.push(ultimo);
                        }
                    }

                    // Log de Verificación para San Fernando
                    if (id === 'SFER') {
                        console.log(`🔎 CHECK SFER: HoraBase=${lastTime}.`);
                        console.log(`   Real=${currentVal}. Astro[0] (Ahora)=${curvaFutura[0]}`);
                        console.log(`   Astro[1] (+1h, debe ser 1.25)=${curvaFutura[1]}`); // ¡Acá veremos la verdad!
                    }

                    data.push({
                        estacion: ID_MAP[id],
                        id_shn: id,
                        altura: currentVal !== null ? currentVal : 0,
                        hora: lastTime,
                        curva: curvaFutura
                    });
                }
            });
        }

        res.json({ status: "ok", source: "SHN API V1", data: data });

    } catch (error) {
        console.error("ERROR CRÍTICO:", error.message);
        res.status(500).json({ error: "Error API SHN", details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server corriendo en puerto ${PORT}`));
