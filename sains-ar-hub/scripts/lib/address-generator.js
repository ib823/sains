'use strict';

/**
 * Generates realistic Negeri Sembilan addresses with district-weighted
 * postcode distribution.
 */

const DISTRICTS = [
  // { code, weight, city, postcodes, tamans }
  {
    code: 'SEREMBAN', weight: 0.40, city: 'Seremban',
    postcodes: ['70100', '70200', '70300', '70400', '70450', '70990'],
    tamans: [
      'Taman Bukit Chedang', 'Taman Rahang Jaya', 'Taman AST', 'Taman Bukit Kepayang',
      'Taman Sri Pagi', 'Taman Tuanku Jaafar', 'Taman Tasik Jaya', 'Taman Senawang Indah',
      'Taman Paroi Jaya', 'Taman Mawar', 'Taman Wira', 'Taman Sri Rasah',
    ],
    streets: ['Jalan Dato Bandar Tunggal', 'Jalan Tuanku Munawir', 'Jalan Yam Tuan', 'Jalan Sultan Hishamuddin'],
  },
  {
    code: 'PORT_DICKSON', weight: 0.12, city: 'Port Dickson',
    postcodes: ['71000', '71050', '71250', '71300', '71350'],
    tamans: ['Taman Pantai', 'Taman Sri PD', 'Taman Sri Sepang', 'Kampung Arab', 'Taman PD Utama'],
    streets: ['Jalan Pantai', 'Jalan Teluk Kemang', 'Jalan Si Rusa'],
  },
  {
    code: 'REMBAU', weight: 0.08, city: 'Rembau',
    postcodes: ['71400', '71450'],
    tamans: ['Taman Rembau Indah', 'Kampung Padang Lebar', 'Taman Sri Rembau'],
    streets: ['Jalan Rembau-Tampin', 'Jalan Pedas-Linggi'],
  },
  {
    code: 'KUALA_PILAH', weight: 0.10, city: 'Kuala Pilah',
    postcodes: ['72000', '72100'],
    tamans: ['Taman Sri Pilah', 'Kampung Parit Tinggi', 'Taman Bukit Senaling'],
    streets: ['Jalan Bahau', 'Jalan Seri Menanti'],
  },
  {
    code: 'JEMPOL', weight: 0.10, city: 'Bahau',
    postcodes: ['72100', '72120', '72200'],
    tamans: ['Taman Bahau Baru', 'Taman Permai', 'Kampung Rompin', 'Taman Jempol Jaya'],
    streets: ['Jalan Besar Bahau', 'Jalan Rompin'],
  },
  {
    code: 'TAMPIN', weight: 0.08, city: 'Tampin',
    postcodes: ['73000', '73200'],
    tamans: ['Taman Tampin Jaya', 'Kampung Pulau', 'Taman Sri Tampin'],
    streets: ['Jalan Besar Tampin', 'Jalan Gemas'],
  },
  {
    code: 'GEMENCHEH', weight: 0.05, city: 'Gemencheh',
    postcodes: ['73200'],
    tamans: ['Kampung Gemencheh', 'Taman Sri Gemencheh'],
    streets: ['Jalan Gemencheh-Tampin'],
  },
  {
    code: 'JELEBU', weight: 0.04, city: 'Kuala Klawang',
    postcodes: ['71600'],
    tamans: ['Kampung Klawang', 'Taman Jelebu Indah'],
    streets: ['Jalan Jelebu', 'Jalan Titi'],
  },
  {
    code: 'SRI_MENANTI', weight: 0.03, city: 'Sri Menanti',
    postcodes: ['70450'],
    tamans: ['Kampung Sri Menanti', 'Taman Diraja'],
    streets: ['Jalan Istana'],
  },
];

function generateAddress(rng) {
  const district = rng.weightedPick(DISTRICTS, DISTRICTS.map(d => d.weight));
  const houseNo = rng.nextInt(1, 999);
  const street = rng.pick(district.streets);
  const taman = rng.pick(district.tamans);
  const postcode = rng.pick(district.postcodes);

  return {
    address1: `${houseNo} ${street}`,
    address2: taman,
    city: district.city,
    state: 'Negeri Sembilan',
    postcode,
    branchCode: district.code === 'PORT_DICKSON' ? 'PDK'
              : district.code === 'KUALA_PILAH' ? 'KPL'
              : district.code === 'JEMPOL' ? 'BHU'
              : district.code === 'TAMPIN' ? 'TPN'
              : district.code === 'REMBAU' ? 'RBU'
              : district.code === 'JELEBU' ? 'JLB'
              : district.code === 'GEMENCHEH' ? 'GMC'
              : 'SRB',
  };
}

module.exports = { generateAddress, DISTRICTS };
