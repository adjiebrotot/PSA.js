// SPDX-License-Identifier: MIT
/**
 * Coordinate reference systems for `n.to_crs`, `n.srid` and `n.crs`: the
 * WKT pyproj writes for a set of EPSG codes and their projections, ported
 * from PROJ (geographic WGS 84 / ETRS89, Popular Visualisation
 * Pseudo-Mercator, Lambert azimuthal equal-area and the Poder/Engsager
 * transverse Mercator of UTM). WGS 84 and ETRS89 are related by PROJ's null
 * transformation ("ETRS89 to WGS 84 (1)"). UTM zones: all of WGS 84 (EPSG
 * 32601-32660 north, 32701-32760 south) and ETRS89 (25828-25838), their WKT
 * built from one template and the zones' USAGE blocks (`src/data/utm_usage.js`).
 */

import { UTM_USAGE } from "../data/utm_usage.js";

/** WKT of the supported non-UTM EPSG codes (pyproj's `CRS.from_epsg(code).to_wkt()`, PROJ 9.8). */
export const CRS_WKT = {
  4326:
    "GEOGCRS[\"WGS 84\",ENSEMBLE[\"World Geodetic System 1984 ensemble\",MEMBER[\"World Geodetic System 1984 (Transit)\"],MEMBER[\"World Geodetic System 1984 (G730)\"],MEMBER[\"World Geodetic System 1984 (G873)\"],MEMBER[\"World Geodetic System 1984 (G1150)\"],MEMBER[\"World Geodetic System 1984 (G1674)\"],MEMBER[\"World Geodetic System 1984 (G1762)\"],MEMBER[\"World Geodetic System 1984 (G2139)\"],MEMBER[\"World Geodetic System 1984 (G2296)\"],ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]],ENSEMBLEACCURACY[2.0]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[ellipsoidal,2],AXIS[\"geodetic latitude (Lat)\",north,ORDER[1],ANGLEUNIT[\"degree\",0.0174532925199433]],AXIS[\"geodetic longitude (Lon)\",east,ORDER[2],ANGLEUNIT[\"degree\",0.0174532925199433]],USAGE[SCOPE[\"Horizontal component of 3D system.\"],AREA[\"World.\"],BBOX[-90,-180,90,180]],ID[\"EPSG\",4326]]",
  4258:
    "GEOGCRS[\"ETRS89\",ENSEMBLE[\"European Terrestrial Reference System 1989 ensemble\",MEMBER[\"European Terrestrial Reference Frame 1989\"],MEMBER[\"European Terrestrial Reference Frame 1990\"],MEMBER[\"European Terrestrial Reference Frame 1991\"],MEMBER[\"European Terrestrial Reference Frame 1992\"],MEMBER[\"European Terrestrial Reference Frame 1993\"],MEMBER[\"European Terrestrial Reference Frame 1994\"],MEMBER[\"European Terrestrial Reference Frame 1996\"],MEMBER[\"European Terrestrial Reference Frame 1997\"],MEMBER[\"European Terrestrial Reference Frame 2000\"],MEMBER[\"European Terrestrial Reference Frame 2005\"],MEMBER[\"European Terrestrial Reference Frame 2014\"],MEMBER[\"European Terrestrial Reference Frame 2020\"],ELLIPSOID[\"GRS 1980\",6378137,298.257222101,LENGTHUNIT[\"metre\",1]],ENSEMBLEACCURACY[0.1]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[ellipsoidal,2],AXIS[\"geodetic latitude (Lat)\",north,ORDER[1],ANGLEUNIT[\"degree\",0.0174532925199433]],AXIS[\"geodetic longitude (Lon)\",east,ORDER[2],ANGLEUNIT[\"degree\",0.0174532925199433]],USAGE[SCOPE[\"Spatial referencing.\"],AREA[\"Europe - onshore and offshore: Albania; Andorra; Austria; Belgium; Bosnia and Herzegovina; Bulgaria; Croatia; Czechia; Denmark; Estonia; Faroe Islands; Finland; France; Germany; Gibraltar; Greece; Hungary; Ireland; Italy; Kosovo; Latvia; Liechtenstein; Lithuania; Luxembourg; Malta; Moldova; Monaco; Montenegro; Netherlands; North Macedonia; Norway including Svalbard and Jan Mayen; Poland; Portugal - mainland; Romania; San Marino; Serbia; Slovakia; Slovenia; Spain - mainland and Balearic islands; Sweden; Switzerland; United Kingdom (UK) including Channel Islands and Isle of Man; Vatican City State.\"],BBOX[33.26,-16.1,84.73,38.01]],ID[\"EPSG\",4258],REMARK[\"Has been realized through ETRF89, ETRF90, ETRF91, ETRF92, ETRF93, ETRF94, ETRF96, ETRF97, ETRF2000, ETRF2005 and ETRF2014. This 'ensemble' covers any or all of these realizations without distinction.\"]]",
  3857:
    "PROJCRS[\"WGS 84 / Pseudo-Mercator\",BASEGEOGCRS[\"WGS 84\",ENSEMBLE[\"World Geodetic System 1984 ensemble\",MEMBER[\"World Geodetic System 1984 (Transit)\"],MEMBER[\"World Geodetic System 1984 (G730)\"],MEMBER[\"World Geodetic System 1984 (G873)\"],MEMBER[\"World Geodetic System 1984 (G1150)\"],MEMBER[\"World Geodetic System 1984 (G1674)\"],MEMBER[\"World Geodetic System 1984 (G1762)\"],MEMBER[\"World Geodetic System 1984 (G2139)\"],MEMBER[\"World Geodetic System 1984 (G2296)\"],ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]],ENSEMBLEACCURACY[2.0]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],ID[\"EPSG\",4326]],CONVERSION[\"Popular Visualisation Pseudo-Mercator\",METHOD[\"Popular Visualisation Pseudo Mercator\",ID[\"EPSG\",1024]],PARAMETER[\"Latitude of natural origin\",0,ANGLEUNIT[\"degree\",0.0174532925199433],ID[\"EPSG\",8801]],PARAMETER[\"Longitude of natural origin\",0,ANGLEUNIT[\"degree\",0.0174532925199433],ID[\"EPSG\",8802]],PARAMETER[\"False easting\",0,LENGTHUNIT[\"metre\",1],ID[\"EPSG\",8806]],PARAMETER[\"False northing\",0,LENGTHUNIT[\"metre\",1],ID[\"EPSG\",8807]]],CS[Cartesian,2],AXIS[\"easting (X)\",east,ORDER[1],LENGTHUNIT[\"metre\",1]],AXIS[\"northing (Y)\",north,ORDER[2],LENGTHUNIT[\"metre\",1]],USAGE[SCOPE[\"Web mapping and visualisation.\"],AREA[\"World between 85.06\u00b0S and 85.06\u00b0N.\"],BBOX[-85.06,-180,85.06,180]],ID[\"EPSG\",3857]]",
  3035:
    "PROJCRS[\"ETRS89-extended / LAEA Europe\",BASEGEOGCRS[\"ETRS89\",ENSEMBLE[\"European Terrestrial Reference System 1989 ensemble\",MEMBER[\"European Terrestrial Reference Frame 1989\"],MEMBER[\"European Terrestrial Reference Frame 1990\"],MEMBER[\"European Terrestrial Reference Frame 1991\"],MEMBER[\"European Terrestrial Reference Frame 1992\"],MEMBER[\"European Terrestrial Reference Frame 1993\"],MEMBER[\"European Terrestrial Reference Frame 1994\"],MEMBER[\"European Terrestrial Reference Frame 1996\"],MEMBER[\"European Terrestrial Reference Frame 1997\"],MEMBER[\"European Terrestrial Reference Frame 2000\"],MEMBER[\"European Terrestrial Reference Frame 2005\"],MEMBER[\"European Terrestrial Reference Frame 2014\"],MEMBER[\"European Terrestrial Reference Frame 2020\"],ELLIPSOID[\"GRS 1980\",6378137,298.257222101,LENGTHUNIT[\"metre\",1]],ENSEMBLEACCURACY[0.1]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],ID[\"EPSG\",4258]],CONVERSION[\"Europe Equal Area 2001\",METHOD[\"Lambert Azimuthal Equal Area\",ID[\"EPSG\",9820]],PARAMETER[\"Latitude of natural origin\",52,ANGLEUNIT[\"degree\",0.0174532925199433],ID[\"EPSG\",8801]],PARAMETER[\"Longitude of natural origin\",10,ANGLEUNIT[\"degree\",0.0174532925199433],ID[\"EPSG\",8802]],PARAMETER[\"False easting\",4321000,LENGTHUNIT[\"metre\",1],ID[\"EPSG\",8806]],PARAMETER[\"False northing\",3210000,LENGTHUNIT[\"metre\",1],ID[\"EPSG\",8807]]],CS[Cartesian,2],AXIS[\"northing (Y)\",north,ORDER[1],LENGTHUNIT[\"metre\",1]],AXIS[\"easting (X)\",east,ORDER[2],LENGTHUNIT[\"metre\",1]],USAGE[SCOPE[\"Statistical analysis.\"],AREA[\"Europe - European Union (EU) countries and candidates. Europe - onshore and offshore: Albania; Andorra; Austria; Belgium; Bosnia and Herzegovina; Bulgaria; Croatia; Cyprus; Czechia; Denmark; Estonia; Faroe Islands; Finland; France; Germany; Gibraltar; Greece; Hungary; Iceland; Ireland; Italy; Kosovo; Latvia; Liechtenstein; Lithuania; Luxembourg; Malta; Monaco; Montenegro; Netherlands; North Macedonia; Norway including Svalbard and Jan Mayen; Poland; Portugal including Madeira and Azores; Romania; San Marino; Serbia; Slovakia; Slovenia; Spain including Canary Islands; Sweden; Switzerland; T\u00fcrkiye (Turkey); United Kingdom (UK) including Channel Islands and Isle of Man; Vatican City State.\"],BBOX[24.6,-35.58,84.73,44.83]],ID[\"EPSG\",3035]]",
};

const DEG = Math.PI / 180;

/** PROJ's `adjlon`: longitude (radians) into [-pi, pi] (a slight overshoot allowed). */
function adjlon(lam) {
  if (Math.abs(lam) < Math.PI + 1e-12) return lam;
  lam += Math.PI;
  lam -= 2 * Math.PI * Math.floor(lam / (2 * Math.PI));
  return lam - Math.PI;
}
const ELLIPSOIDS = { WGS84: 298.257223563, GRS80: 298.257222101 };

function ellipsoid(name) {
  const a = 6378137;
  const f = 1 / ELLIPSOIDS[name];
  const es = 2 * f - f * f;
  return { a, es, e: Math.sqrt(es), oneEs: 1 - es };
}

/** PROJ's `pj_qsfn`. */
function qsfn(sinphi, e, oneEs) {
  const con = e * sinphi;
  return oneEs * (sinphi / (1 - con * con) - (0.5 / e) * Math.log((1 - con) / (1 + con)));
}

/**
 * Geodetic latitude of the authalic latitude with sine `sinBeta`: Newton
 * iterations on `q(phi) = qp * sin(beta)` (Snyder 3-16), exact to machine
 * precision like PROJ's current inverse.
 */
function authalicInverse(sinBeta, { e, es, oneEs, qp }) {
  const q = qp * sinBeta;
  let phi = Math.asin(q / 2);
  for (let k = 0; k < 20; k++) {
    const sinphi = Math.sin(phi);
    const cosphi = Math.cos(phi);
    const con = e * sinphi;
    const com = 1 - con * con;
    const dphi = ((com * com) / (2 * cosphi)) * (q / oneEs - sinphi / com + (0.5 / e) * Math.log((1 - con) / (1 + con)));
    phi += dphi;
    if (Math.abs(dphi) < 1e-15) break;
  }
  return phi;
}

/** Lambert azimuthal equal-area, ellipsoidal oblique aspect (PROJ `laea`). */
function laea({ lat0, lon0, x0, y0, ellps }) {
  const { a, es, e, oneEs } = ellipsoid(ellps);
  const phi0 = lat0 * DEG;
  const lam0 = lon0 * DEG;
  const qp = qsfn(1, e, oneEs);
  const rq = Math.sqrt(0.5 * qp);
  const sinphi0 = Math.sin(phi0);
  const sinb1 = qsfn(sinphi0, e, oneEs) / qp;
  const cosb1 = Math.sqrt(1 - sinb1 * sinb1);
  const dd = Math.cos(phi0) / (Math.sqrt(1 - es * sinphi0 * sinphi0) * rq * cosb1);
  const ymf = rq / dd;
  const xmf = rq * dd;
  return {
    forward(lon, lat) {
      const lam = adjlon(lon * DEG - lam0);
      const sinphi = Math.sin(lat * DEG);
      const sinb = qsfn(sinphi, e, oneEs) / qp;
      const cosb2 = 1 - sinb * sinb;
      const cosb = cosb2 > 0 ? Math.sqrt(cosb2) : 0;
      const coslam = Math.cos(lam);
      let b = 1 + sinb1 * sinb + cosb1 * cosb * coslam;
      b = Math.sqrt(2 / b);
      const y = ymf * b * (cosb1 * sinb - sinb1 * cosb * coslam);
      const x = xmf * b * cosb * Math.sin(lam);
      return [a * x + x0, a * y + y0];
    },
    inverse(x, y) {
      let px = (x - x0) / a / dd;
      let py = ((y - y0) / a) * dd;
      const rho = Math.hypot(px, py);
      if (rho < 1e-10) return [lon0, lat0];
      let sCe = 2 * Math.asin((0.5 * rho) / rq);
      const cCe = Math.cos(sCe);
      sCe = Math.sin(sCe);
      px *= sCe;
      const ab = cCe * sinb1 + (py * sCe * cosb1) / rho;
      py = rho * cosb1 * cCe - py * sinb1 * sCe;
      return [adjlon(Math.atan2(px, py) + lam0) / DEG, authalicInverse(ab, { e, es, oneEs, qp }) / DEG];
    },
  };
}

/** Popular Visualisation Pseudo-Mercator (PROJ `webmerc`, spherical). */
function webmerc() {
  const a = 6378137;
  return {
    forward: (lon, lat) => [a * adjlon(lon * DEG), a * Math.asinh(Math.tan(lat * DEG))],
    inverse: (x, y) => [adjlon(x / a) / DEG, Math.atan(Math.sinh(y / a)) / DEG],
  };
}

// Poder/Engsager transverse Mercator (PROJ `tmerc` exact algorithm)
const gatg = (p, B, cos2B, sin2B) => {
  const two = 2 * cos2B;
  let h1 = p[p.length - 1];
  let h2 = 0;
  let h = 0;
  for (let k = p.length - 2; k >= 0; k--) {
    h = -h2 + two * h1 + p[k];
    h2 = h1;
    h1 = h;
  }
  return B + h * sin2B;
};
const clenS = (a, argR, argI) => {
  const sinR = Math.sin(argR);
  const cosR = Math.cos(argR);
  const sinhI = Math.sinh(argI);
  const coshI = Math.cosh(argI);
  let r = 2 * cosR * coshI;
  let i = -2 * sinR * sinhI;
  let hr = a[a.length - 1];
  let hi = 0;
  let hr1 = 0;
  let hi1 = 0;
  for (let k = a.length - 2; k >= 0; k--) {
    const hr2 = hr1;
    const hi2 = hi1;
    hr1 = hr;
    hi1 = hi;
    hr = -hr2 + r * hr1 - i * hi1 + a[k];
    hi = -hi2 + i * hr1 + r * hi1;
  }
  r = sinR * coshI;
  i = cosR * sinhI;
  return [r * hr - i * hi, r * hi + i * hr];
};
const clens = (a, arg) => {
  const r = 2 * Math.cos(arg);
  let hr = a[a.length - 1];
  let hr1 = 0;
  for (let k = a.length - 2; k >= 0; k--) {
    const hr2 = hr1;
    hr1 = hr;
    hr = -hr2 + r * hr1 + a[k];
  }
  return Math.sin(arg) * hr;
};

function tmerc({ lon0, k0, x0, y0, ellps }) {
  const { a, es } = ellipsoid(ellps);
  const lam0 = lon0 * DEG;
  const f = es / (1 + Math.sqrt(1 - es));
  const n = f / (2 - f);
  let np = n;
  const cgb = [];
  const cbg = [];
  cgb[0] = n * (2 + n * (-2 / 3 + n * (-2 + n * (116 / 45 + n * (26 / 45 + n * (-2854 / 675))))));
  cbg[0] = n * (-2 + n * (2 / 3 + n * (4 / 3 + n * (-82 / 45 + n * (32 / 45 + n * (4642 / 4725))))));
  np = n * n;
  cgb[1] = np * (7 / 3 + n * (-8 / 5 + n * (-227 / 45 + n * (2704 / 315 + n * (2323 / 945)))));
  cbg[1] = np * (5 / 3 + n * (-16 / 15 + n * (-13 / 9 + n * (904 / 315 + n * (-1522 / 945)))));
  np *= n;
  cgb[2] = np * (56 / 15 + n * (-136 / 35 + n * (-1262 / 105 + n * (73814 / 2835))));
  cbg[2] = np * (-26 / 15 + n * (34 / 21 + n * (8 / 5 + n * (-12686 / 2835))));
  np *= n;
  cgb[3] = np * (4279 / 630 + n * (-332 / 35 + n * (-399572 / 14175)));
  cbg[3] = np * (1237 / 630 + n * (-12 / 5 + n * (-24832 / 14175)));
  np *= n;
  cgb[4] = np * (4174 / 315 + n * (-144838 / 6237));
  cbg[4] = np * (-734 / 315 + n * (109598 / 31185));
  np *= n;
  cgb[5] = np * (601676 / 22275);
  cbg[5] = np * (444337 / 155925);
  np = n * n;
  const Qn = (k0 / (1 + n)) * (1 + np * (1 / 4 + np * (1 / 64 + np / 256)));
  const utg = [];
  const gtu = [];
  utg[0] = n * (-0.5 + n * (2 / 3 + n * (-37 / 96 + n * (1 / 360 + n * (81 / 512 + n * (-96199 / 604800))))));
  gtu[0] = n * (0.5 + n * (-2 / 3 + n * (5 / 16 + n * (41 / 180 + n * (-127 / 288 + n * (7891 / 37800))))));
  utg[1] = np * (-1 / 48 + n * (-1 / 15 + n * (437 / 1440 + n * (-46 / 105 + n * (1118711 / 3870720)))));
  gtu[1] = np * (13 / 48 + n * (-3 / 5 + n * (557 / 1440 + n * (281 / 630 + n * (-1983433 / 1935360)))));
  np *= n;
  utg[2] = np * (-17 / 480 + n * (37 / 840 + n * (209 / 4480 + n * (-5569 / 90720))));
  gtu[2] = np * (61 / 240 + n * (-103 / 140 + n * (15061 / 26880 + n * (167603 / 181440))));
  np *= n;
  utg[3] = np * (-4397 / 161280 + n * (11 / 504 + n * (830251 / 7257600)));
  gtu[3] = np * (49561 / 161280 + n * (-179 / 168 + n * (6601661 / 7257600)));
  np *= n;
  utg[4] = np * (-4583 / 161280 + n * (108847 / 3991680));
  gtu[4] = np * (34729 / 80640 + n * (-3418889 / 1995840));
  np *= n;
  utg[5] = np * (-20648693 / 638668800);
  gtu[5] = np * (212378941 / 319334400);
  // origin latitude 0: Zb = 0
  const Zb = -Qn * (0 + clens(gtu, 0));
  return {
    forward(lon, lat) {
      const phi = lat * DEG;
      let Cn = gatg(cbg, phi, Math.cos(2 * phi), Math.sin(2 * phi));
      const lam = adjlon(lon * DEG - lam0);
      const sinCn = Math.sin(Cn);
      const cosCn = Math.cos(Cn);
      const sinCe = Math.sin(lam);
      const cosCe = Math.cos(lam);
      Cn = Math.atan2(sinCn, cosCe * cosCn);
      let Ce = Math.atan2(sinCe * cosCn, Math.hypot(sinCn, cosCn * cosCe));
      Ce = Math.asinh(Math.tan(Ce));
      const [dCn, dCe] = clenS(gtu, 2 * Cn, 2 * Ce);
      Cn += dCn;
      Ce += dCe;
      return [a * (Qn * Ce) + x0, a * (Qn * Cn + Zb) + y0];
    },
    inverse(x, y) {
      let Cn = ((y - y0) / a - Zb) / Qn;
      let Ce = (x - x0) / a / Qn;
      const [dCn, dCe] = clenS(utg, 2 * Cn, 2 * Ce);
      Cn += dCn;
      Ce += dCe;
      Ce = Math.atan(Math.sinh(Ce));
      const sinCn = Math.sin(Cn);
      const cosCn = Math.cos(Cn);
      const sinCe = Math.sin(Ce);
      const cosCe = Math.cos(Ce);
      Ce = Math.atan2(sinCe, cosCe * cosCn);
      Cn = Math.atan2(sinCn * cosCe, Math.hypot(sinCe, cosCe * cosCn));
      const phi = gatg(cgb, Cn, Math.cos(2 * Cn), Math.sin(2 * Cn));
      return [adjlon(Ce + lam0) / DEG, phi / DEG];
    },
  };
}

const UTM_BASE = {
  WGS84: "BASEGEOGCRS[\"WGS 84\",ENSEMBLE[\"World Geodetic System 1984 ensemble\",MEMBER[\"World Geodetic System 1984 (Transit)\"],MEMBER[\"World Geodetic System 1984 (G730)\"],MEMBER[\"World Geodetic System 1984 (G873)\"],MEMBER[\"World Geodetic System 1984 (G1150)\"],MEMBER[\"World Geodetic System 1984 (G1674)\"],MEMBER[\"World Geodetic System 1984 (G1762)\"],MEMBER[\"World Geodetic System 1984 (G2139)\"],MEMBER[\"World Geodetic System 1984 (G2296)\"],ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]],ENSEMBLEACCURACY[2.0]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],ID[\"EPSG\",4326]]",
  GRS80: "BASEGEOGCRS[\"ETRS89\",ENSEMBLE[\"European Terrestrial Reference System 1989 ensemble\",MEMBER[\"European Terrestrial Reference Frame 1989\"],MEMBER[\"European Terrestrial Reference Frame 1990\"],MEMBER[\"European Terrestrial Reference Frame 1991\"],MEMBER[\"European Terrestrial Reference Frame 1992\"],MEMBER[\"European Terrestrial Reference Frame 1993\"],MEMBER[\"European Terrestrial Reference Frame 1994\"],MEMBER[\"European Terrestrial Reference Frame 1996\"],MEMBER[\"European Terrestrial Reference Frame 1997\"],MEMBER[\"European Terrestrial Reference Frame 2000\"],MEMBER[\"European Terrestrial Reference Frame 2005\"],MEMBER[\"European Terrestrial Reference Frame 2014\"],MEMBER[\"European Terrestrial Reference Frame 2020\"],ELLIPSOID[\"GRS 1980\",6378137,298.257222101,LENGTHUNIT[\"metre\",1]],ENSEMBLEACCURACY[0.1]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],ID[\"EPSG\",4258]]",
};

/** Zone, hemisphere and ellipsoid of a UTM EPSG code, or null. */
function utmZone(epsg) {
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, south: false, ellps: "WGS84" };
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, south: true, ellps: "WGS84" };
  if (epsg >= 25828 && epsg <= 25838) return { zone: epsg - 25800, south: false, ellps: "GRS80" };
  return null;
}

const utmLon0 = (zone) => (zone - 1) * 6 - 180 + 3;

/** pyproj's WKT of a UTM zone. */
function utmWkt(epsg) {
  const u = utmZone(epsg);
  if (!u) return null;
  const name = `UTM zone ${u.zone}${u.south ? "S" : "N"}`;
  const deg = 'ANGLEUNIT["degree",0.0174532925199433]';
  const metre = 'LENGTHUNIT["metre",1]';
  return (
    `PROJCRS["${u.ellps === "WGS84" ? "WGS 84" : "ETRS89"} / ${name}",${UTM_BASE[u.ellps]},` +
    `CONVERSION["${name}",METHOD["Transverse Mercator",ID["EPSG",9807]],` +
    `PARAMETER["Latitude of natural origin",0,${deg},ID["EPSG",8801]],` +
    `PARAMETER["Longitude of natural origin",${utmLon0(u.zone)},${deg},ID["EPSG",8802]],` +
    `PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1],ID["EPSG",8805]],` +
    `PARAMETER["False easting",500000,${metre},ID["EPSG",8806]],` +
    `PARAMETER["False northing",${u.south ? 10000000 : 0},${metre},ID["EPSG",8807]]],` +
    `CS[Cartesian,2],AXIS["(E)",east,ORDER[1],${metre}],AXIS["(N)",north,ORDER[2],${metre}],` +
    `${UTM_USAGE[epsg]},ID["EPSG",${epsg}]]`
  );
}

const geographic = { forward: (lon, lat) => [lon, lat], inverse: (lon, lat) => [lon, lat], geographic: true };
const utm = ({ zone, south, ellps }) => tmerc({ lon0: utmLon0(zone), k0: 0.9996, x0: 500000, y0: south ? 10000000 : 0, ellps });

/** Projection (`forward(lon, lat)` / `inverse(x, y)`, east-north order) and axis order per EPSG code. */
const SYSTEMS = {
  4326: { proj: () => geographic, latFirst: true },
  4258: { proj: () => geographic, latFirst: true },
  3857: { proj: webmerc, latFirst: false },
  3035: { proj: () => laea({ lat0: 52, lon0: 10, x0: 4321000, y0: 3210000, ellps: "GRS80" }), northFirst: true },
};

/** EPSG code of a CRS given as a number, "EPSG:<code>", a WKT with an EPSG id or `{epsg}`. */
export function epsgOf(crs) {
  if (crs === null || crs === undefined) return null;
  if (typeof crs === "number") return crs;
  if (typeof crs === "object") return crs.epsg ?? epsgOf(crs._crs);
  const s = String(crs).trim();
  let m = /^(?:EPSG:)?(\d+)$/i.exec(s);
  if (m) return Number(m[1]);
  m = /ID\["EPSG",(\d+)\]\]$/.exec(s);
  return m ? Number(m[1]) : null;
}

/** pyproj's WKT of an EPSG code (null when PSA.js does not know it). */
export const wktOf = (epsg) => CRS_WKT[epsg] ?? utmWkt(epsg);

function system(epsg) {
  const s = SYSTEMS[epsg];
  if (s) return s;
  const u = utmZone(epsg);
  if (u) return { proj: () => utm(u) };
  throw new Error(
    `NotImplementedError: coordinate transformations for EPSG:${epsg} are not available in PSA.js (supported: ${Object.keys(SYSTEMS).join(", ")} and the UTM zones 32601-32660, 32701-32760, 25828-25838)`,
  );
}

/**
 * `pyproj.Transformer.from_crs(from, to, always_xy)`: a function of the two
 * input coordinates returning the two output coordinates, in each CRS's axis
 * order (latitude first for geographic CRS, northing first for LAEA Europe)
 * unless `always_xy`.
 */
export function transformer(from, to, { always_xy = false } = {}) {
  const src = system(from);
  const dst = system(to);
  const p = src.proj();
  const q = dst.proj();
  const INF = [Infinity, Infinity];
  return (u, v) => {
    const [x, y] = !always_xy && (src.latFirst || src.northFirst) ? [v, u] : [u, v];
    // PROJ marks failed coordinates with HUGE_VAL, which propagates
    if (x === Infinity || y === Infinity || x === -Infinity || y === -Infinity) return INF;
    const [lon, lat] = p.inverse(x, y);
    // projections reject latitudes beyond the poles and longitudes beyond 10 rad
    if (!q.geographic && (Math.abs(lat * DEG) - Math.PI / 2 > 1e-12 || Math.abs(lon * DEG) > 10)) return INF;
    const [X, Y] = q.forward(lon, lat);
    return !always_xy && (dst.latFirst || dst.northFirst) ? [Y, X] : [X, Y];
  };
}
