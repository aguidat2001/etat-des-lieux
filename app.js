"use strict";
/* État des lieux – application iPhone (PWA). Tout est stocké sur le téléphone (IndexedDB). */

// --- Modèle ---------------------------------------------------------------------------------------
const ETATS = ["Neuf", "Bon", "Usé", "Mauvais"];
const ELEMENTS_PIECE = ["Sols", "Murs", "Plafond", "Portes / huisseries", "Fenêtres / volets",
  "Électricité (prises, interrupteurs, éclairage)", "Chauffage / radiateurs", "Équipements / mobilier"];
const ELEMENTS_SPECIFIQUES = {
  "cuisine": ["Évier / robinetterie", "Plaques / four / hotte", "Placards / plan de travail"],
  "salle de bain": ["Lavabo / robinetterie", "Douche / baignoire", "Joints / faïence", "Ventilation"],
  "wc": ["Cuvette / chasse d'eau", "Ventilation"],
};
const CLES = ["Porte d'entrée", "Boîte aux lettres", "Badge / bip / digicode", "Garage / cave"];
const PIECES_DEFAUT = ["Entrée", "Séjour", "Cuisine", "Chambre 1", "Salle de bain", "WC"];
const COMPTEURS_DEFAUT = ["Eau", "Électricité", "Gaz"];

function elementsPour(nomPiece) {
  const cle = nomPiece.toLowerCase();
  if (["garage", "cave", "parking"].some(m => cle.includes(m)))
    return ["Sol", "Murs / plafond", "Porte / serrure", "Éclairage", "Équipements"];
  let elements = [...ELEMENTS_PIECE];
  for (const [mot, extra] of Object.entries(ELEMENTS_SPECIFIQUES))
    if (cle.includes(mot) || (mot === "salle de bain" && cle.includes("salle d'eau")))
      elements = [...elements.slice(0, 6), ...extra, ...elements.slice(6)];
  return [...new Set(elements)];
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const aujourdhui = () => new Date().toLocaleDateString("sv");   // AAAA-MM-JJ local
const nouvellePiece = nom => ({ id: uid(), nom, photos: [], obs: "",
  elements: elementsPour(nom).map(n => ({ nom: n, etat: "", obs: "", photos: [] })) });

// --- Stockage (IndexedDB) -------------------------------------------------------------------------
const base = new Promise((ok, ko) => {
  const r = indexedDB.open("etat-des-lieux", 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("edl", { keyPath: "id" });
    r.result.createObjectStore("photos", { keyPath: "id" });
    r.result.createObjectStore("kv", { keyPath: "k" });
  };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => ko(r.error);
});
async function tx(store, mode, fn) {
  const db = await base;
  return new Promise((ok, ko) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => ok(req && req.result);
    t.onerror = () => ko(t.error);
  });
}
const lireTout = s => tx(s, "readonly", o => o.getAll());
const lire = (s, k) => tx(s, "readonly", o => o.get(k));
const ecrire = (s, v) => tx(s, "readwrite", o => o.put(v));
const effacer = (s, k) => tx(s, "readwrite", o => o.delete(k));
const lireKV = async (k, defaut) => ((await lire("kv", k)) || {}).v ?? defaut;
const ecrireKV = (k, v) => ecrire("kv", { k, v });

// --- Outils -----------------------------------------------------------------------------------------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDate = iso => iso ? iso.slice(0, 10).split("-").reverse().join("/") : "";
const fmtHeure = iso => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const libelleType = e => e.type === "sortie" ? "sortie" : "entrée";
function toast(msg, ms = 2600) {
  const d = document.createElement("div");
  d.className = "toast"; d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), ms);
}
function attente(msg) {
  const d = document.createElement("div");
  d.className = "attente"; d.textContent = msg;
  document.body.appendChild(d);
  return () => d.remove();
}
/** Tous les identifiants de photos contenus dans un objet (pièce, élément, compteur, état des lieux…). */
function idsPhotos(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).flatMap(([k, v]) => k === "photos" && Array.isArray(v) ? v : idsPhotos(v));
}
function getPath(obj, path) { return path.split(".").reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, val) {
  const ks = path.split("."), last = ks.pop();
  ks.reduce((o, k) => o[k], obj)[last] = val;
}

// --- État de l'interface ------------------------------------------------------------------------------
const ui = { page: "accueil", edl: null, piecesOuvertes: new Set(), pdf: null };
let reglages = { nom: "", prenom: "", telephone: "", adresse: "", email: "", ville: "" };
let donnees = null;              // export du logiciel de gestion
const urlsPhotos = new Map();     // id -> objectURL

async function urlPhoto(id) {
  if (!urlsPhotos.has(id)) {
    const p = await lire("photos", id);
    urlsPhotos.set(id, p ? URL.createObjectURL(p.blob) : "");
  }
  return urlsPhotos.get(id);
}

let minuterie = null;
function sauver(immediat) {
  if (!ui.edl) return;
  clearTimeout(minuterie);
  const go = () => { ui.edl.modifie = new Date().toISOString(); ecrire("edl", ui.edl); };
  immediat ? go() : (minuterie = setTimeout(go, 400));
}
document.addEventListener("visibilitychange", () => { if (document.hidden) sauver(true); });

const verrouille = e => Object.keys(e.signatures || {}).length > 0;
const nomComplet = p => [p?.prenom, p?.nom].map(s => (s || "").trim()).filter(Boolean).join(" ");
function signataires(e) {
  return [{ cle: "bailleur", role: "Propriétaire / bailleur", nom: nomComplet(e.bailleur) },
    ...e.locataires.map((l, i) => ({ cle: "loc" + i, role: e.locataires.length > 1 ? `Locataire ${i + 1}` : "Locataire", nom: nomComplet(l) })),
    ...e.cautions.map((c, i) => ({ cle: "cau" + i, caution: true, nom: nomComplet(c),
      role: (e.cautions.length > 1 ? `Caution ${i + 1}` : "Caution") + (c.pour ? ` de ${c.pour}` : "") }))];
}

/** Champs d'une personne : nom, prénom, téléphone, mail (+ date et lieu de naissance). */
function champsPersonne(chemin, p, { naissance = false, adresse = false } = {}) {
  const champ = (cle, libelle, type = "text", extra = "") =>
    `<label class="champ">${libelle}<input type="${type}" ${extra} data-bind="${chemin}.${cle}" value="${esc(p[cle])}"></label>`;
  return `<div class="deux">${champ("nom", "Nom")}${champ("prenom", "Prénom")}</div>
    <div class="deux">${champ("telephone", "Téléphone", "tel", 'inputmode="tel" autocomplete="off"')}${champ("email", "Mail", "email")}</div>
    ${naissance ? `<div class="deux">${champ("naissanceDate", "Date de naissance", "date")}${champ("naissanceLieu", "Lieu de naissance")}</div>` : ""}
    ${adresse ? champ("adresse", "Adresse") : ""}`;
}
const personneVide = () => ({ nom: "", prenom: "", telephone: "", email: "", naissanceDate: "", naissanceLieu: "" });

/** Complète les états des lieux créés avec une version précédente de l'appli. */
function normaliser(e) {
  e.cautions ||= [];
  if (e.locatairePrecedent === undefined) e.locatairePrecedent = null;
  return e;
}

// --- Rendu --------------------------------------------------------------------------------------------
function rendre() {
  const app = $("#app");
  if (ui.page === "accueil") return rendreAccueil(app);
  if (ui.page === "reglages") return rendreReglages(app);
  if (ui.page === "edl") return rendreEdl(app);
}

async function rendreAccueil(app) {
  const liste = (await lireTout("edl")).sort((a, b) => (b.modifie || "").localeCompare(a.modifie || ""));
  app.innerHTML = `
  <header><h1>États des lieux</h1><button data-action="reglages" aria-label="Réglages">⚙︎</button></header>
  <main>
    <button class="principal" style="width:100%;justify-content:center;padding:13px;margin-bottom:14px" data-action="nouveau">＋ Nouvel état des lieux</button>
    ${!donnees ? `<div class="carte doux">Astuce : importez la liste de vos locataires depuis le logiciel de gestion
      (menu Fichier → « Exporter les locataires vers l'appli iPhone »), puis ⚙︎ Réglages → Importer.</div>` : ""}
    <div class="liste-edl">
    ${liste.length ? liste.map(e => `
      <button class="carte" data-action="ouvrir" data-id="${e.id}">
        <div class="ligne"><b class="etire">${esc(e.locataires.map(nomComplet).filter(Boolean).join(", ") || "Sans locataire")}</b>
          <span class="puce ${e.statut === "signe" ? "signe" : ""}">${e.statut === "signe" ? "Signé" : verrouille(e) ? "Signature en cours" : "Brouillon"}</span></div>
        <div class="doux">État des lieux de ${libelleType(e)} · ${fmtDate(e.date)}</div>
        <div class="doux">${esc([e.logement, e.adresse].filter(Boolean).join(" — "))}</div>
      </button>`).join("") : `<div class="vide">Aucun état des lieux pour l'instant.</div>`}
    </div>
  </main>`;
}

async function rendreReglages(app) {
  const nb = donnees ? donnees.locataires.length : 0;
  let usage = "";
  try {
    const est = await navigator.storage.estimate();
    usage = `Espace utilisé : ${(est.usage / 1048576).toFixed(1)} Mo`;
  } catch (_) { /* non disponible */ }
  app.innerHTML = `
  <header><button class="lien" data-action="accueil">‹ Retour</button><h1>Réglages</h1></header>
  <main>
    <div class="carte"><h2>Propriétaire (valeurs par défaut)</h2>
      <div class="deux"><label class="champ">Nom<input data-reglage="nom" value="${esc(reglages.nom)}"></label>
      <label class="champ">Prénom<input data-reglage="prenom" value="${esc(reglages.prenom)}"></label></div>
      <label class="champ">Téléphone<input type="tel" data-reglage="telephone" value="${esc(reglages.telephone)}"></label>
      <label class="champ">Adresse<textarea data-reglage="adresse">${esc(reglages.adresse)}</textarea></label>
      <label class="champ">Adresse mail (pour recevoir une copie)<input type="email" data-reglage="email" value="${esc(reglages.email)}"></label>
      <label class="champ">Ville (« Fait à … »)<input data-reglage="ville" value="${esc(reglages.ville)}"></label>
    </div>
    <div class="carte"><h2>Données du logiciel de gestion</h2>
      <p class="doux">${nb ? `${nb} locataire(s) importé(s) le ${fmtDate(donnees.importe_le)}.` : "Aucune donnée importée."}</p>
      <label class="bouton principal" style="position:relative">Importer le fichier .json
        <input type="file" accept=".json,application/json" data-action="importer" style="position:absolute;inset:0;opacity:0"></label>
    </div>
    <div class="carte doux">${usage}<br>Les états des lieux et les photos sont enregistrés uniquement sur cet iPhone.
      Pensez à envoyer chaque état des lieux signé par mail : c'est le PDF qui fait foi et qui s'archive dans le logiciel.</div>
  </main>`;
}

function segmentEtat(chemin, valeur) {
  return `<div class="segment" data-etat="${chemin}">${ETATS.map(e =>
    `<button type="button" class="${valeur === e ? "actif e-" + e : ""}" data-val="${e}">${e}</button>`).join("")}</div>`;
}
/** Notation de l'état des lieux d'entrée, affichée sous celle de sortie (lecture seule). */
function segmentLecture(valeur) {
  return `<div class="segment lecture" aria-label="État à l'entrée : ${esc(valeur || "non noté")}">${ETATS.map(e =>
    `<span class="${valeur === e ? "actif e-" + e : ""}">${e}</span>`).join("")}</div>`;
}

function blocPhotos(chemin, ids) {
  return `<div class="photos" id="ph-${chemin.replace(/\./g, "-")}">${(ids || []).map((id, i) =>
    `<div class="vignette"><img data-photo-id="${id}" alt="" data-action="voir-photo" data-id="${id}">
       <button type="button" class="masquer-si-signe" data-action="suppr-photo" data-chemin="${chemin}" data-i="${i}">✕</button></div>`).join("")}
    <label class="ajout-photo masquer-si-signe">📷<input type="file" accept="image/*" multiple data-photos="${chemin}"></label></div>`;
}

function rendreEdl(app) {
  const e = ui.edl, bloque = verrouille(e);
  const sigs = signataires(e);
  const nbSig = sigs.filter(s => e.signatures[s.cle]).length;
  app.innerHTML = `
  <header><button class="lien" data-action="accueil">‹ Liste</button>
    <h1>${e.type === "sortie" ? "Sortie" : "Entrée"} – ${esc(nomComplet(e.locataires[0]))}</h1>
    <button data-action="menu-edl" aria-label="Plus">⋯</button></header>
  <main>
  ${bloque ? `<div class="verrou">🔒 ${e.statut === "signe" ? "Signé par toutes les parties" : `Signature en cours (${nbSig}/${sigs.length})`} :
     le contenu ne peut plus être modifié. <button class="lien" data-action="deverrouiller">Modifier quand même…</button></div>` : ""}
  <fieldset ${bloque ? "disabled" : ""}>
    <div class="carte"><h2>Général</h2>
      <div class="segment" style="margin-bottom:10px" data-type>
        <button type="button" class="${e.type === "entree" ? "actif" : ""}" data-val="entree">Entrée</button>
        <button type="button" class="${e.type === "sortie" ? "actif" : ""}" data-val="sortie">Sortie</button></div>
      <div class="deux">
        <label class="champ">Date<input type="date" data-bind="date" value="${esc(e.date)}"></label>
        <label class="champ">Fait à<input data-bind="ville" value="${esc(e.ville)}"></label></div>
      <label class="champ">Logement<input data-bind="logement" value="${esc(e.logement)}"></label>
      <label class="champ">Adresse<input data-bind="adresse" value="${esc(e.adresse)}"></label>
      <label class="champ">Date d'entrée dans les lieux<input type="date" data-bind="dateEntree" value="${esc(e.dateEntree)}"></label>
    </div>
    <div class="carte"><h2>Propriétaire</h2>
      ${champsPersonne("bailleur", e.bailleur, { adresse: true })}
    </div>
    <div class="carte"><h2>Locataire(s)</h2>
      ${e.locataires.map((l, i) => `<div class="${i ? "element" : ""}">
        ${e.locataires.length > 1 ? `<div class="nom"><span class="etire">Locataire ${i + 1}</span>
          ${i > 0 ? `<button type="button" class="lien danger masquer-si-signe" data-action="suppr" data-chemin="locataires" data-i="${i}">Retirer</button>` : ""}</div>` : ""}
        ${champsPersonne(`locataires.${i}`, l, { naissance: true, adresse: true })}</div>`).join("")}
      <button type="button" class="lien masquer-si-signe" data-action="ajout-locataire">＋ Ajouter un co-locataire</button>
    </div>
    <div class="carte"><h2>Caution(s) / garant(s)</h2>
      ${e.cautions.length ? "" : `<p class="doux" style="margin-top:0">Aucune caution. Ajoutez-en une si le garant est présent et signe l'état des lieux.</p>`}
      ${e.cautions.map((c, i) => `<div class="element">
        <div class="nom"><span class="etire">Caution ${e.cautions.length > 1 ? i + 1 : ""}</span>
          <button type="button" class="lien danger masquer-si-signe" data-action="suppr" data-chemin="cautions" data-i="${i}">Retirer</button></div>
        ${champsPersonne(`cautions.${i}`, c, { naissance: true, adresse: true })}
        ${e.locataires.length > 1 ? `<label class="champ">Se porte caution de
          <select data-bind="cautions.${i}.pour"><option value="">Tous les locataires</option>
          ${e.locataires.map(l => nomComplet(l)).map(n => `<option ${c.pour === n ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>` : ""}
      </div>`).join("")}
      <button type="button" class="lien masquer-si-signe" data-action="ajout-caution">＋ Ajouter une caution</button>
    </div>
    ${e.locatairePrecedent ? `<div class="carte"><div class="nom ligne" style="margin-bottom:10px"><h2 class="etire" style="margin:0">Locataire précédent</h2>
        <button type="button" class="lien danger masquer-si-signe" data-action="suppr-precedent">Retirer</button></div>
      ${champsPersonne("locatairePrecedent", e.locatairePrecedent)}
      <label class="champ">Date de sortie<input type="date" data-bind="locatairePrecedent.dateSortie" value="${esc(e.locatairePrecedent.dateSortie)}"></label>
    </div>` : `<button type="button" class="masquer-si-signe" style="width:100%;justify-content:center;margin-bottom:12px" data-action="ajout-precedent">＋ Ajouter le locataire précédent</button>`}
    <div class="carte"><h2>Compteurs</h2>
      ${e.compteurs.map((c, i) => `<div class="element">
        <div class="nom"><span class="etire">${esc(c.nom)}</span>
          <button type="button" class="lien danger masquer-si-signe" data-action="suppr" data-chemin="compteurs" data-i="${i}">Retirer</button></div>
        ${c.dernier ? `<div class="entree">Relevé précédent : ${esc(c.dernier)}</div>` : ""}
        <div class="deux"><label class="champ">N° de compteur<input data-bind="compteurs.${i}.numero" value="${esc(c.numero)}"></label>
        <label class="champ">Index relevé<input inputmode="decimal" data-bind="compteurs.${i}.index" value="${esc(c.index)}"></label></div>
        ${blocPhotos(`compteurs.${i}.photos`, c.photos)}</div>`).join("")}
      <button type="button" class="lien masquer-si-signe" data-action="ajout-compteur">＋ Ajouter un compteur</button>
    </div>
    <div class="carte"><h2>Clés et accès remis</h2>
      ${e.cles.map((c, i) => `<div class="ligne" style="margin-bottom:8px">
        <input class="plein etire" data-bind="cles.${i}.nom" value="${esc(c.nom)}" style="margin:0">
        <input class="plein" inputmode="numeric" placeholder="Nb" data-bind="cles.${i}.nombre" value="${esc(c.nombre)}" style="width:62px;margin:0">
        <button type="button" class="lien danger masquer-si-signe" data-action="suppr" data-chemin="cles" data-i="${i}">✕</button></div>`).join("")}
      <button type="button" class="lien masquer-si-signe" data-action="ajout-cle">＋ Ajouter</button>
    </div>
    <h2 style="font-size:17px;margin:18px 4px 10px">Pièces</h2>
    ${e.pieces.map((p, pi) => {
      const faits = p.elements.filter(x => x.etat).length;
      return `<details class="piece" data-piece="${p.id}" ${ui.piecesOuvertes.has(p.id) ? "open" : ""}>
      <summary>${esc(p.nom)} <span class="puce ${faits === p.elements.length ? "signe" : ""}">${faits}/${p.elements.length}</span></summary>
      <div class="piece-corps">
        <label class="champ masquer-si-signe">Nom de la pièce<input data-bind="pieces.${pi}.nom" value="${esc(p.nom)}"></label>
        <div class="doux">Photos d'ensemble</div>${blocPhotos(`pieces.${pi}.photos`, p.photos)}
        ${p.elements.map((x, xi) => `<div class="element">
          <div class="nom"><span class="etire">${esc(x.nom)}</span>
            <button type="button" class="lien danger masquer-si-signe" data-action="suppr" data-chemin="pieces.${pi}.elements" data-i="${xi}">✕</button></div>
          ${x.entree ? `<div class="libelle-etat">Entrée${x.entree.etat ? "" : " : non noté"}</div>${segmentLecture(x.entree.etat)}` : ""}
          ${x.entree?.obs ? `<div class="obs-entree"><b>Observation d'entrée :</b> ${esc(x.entree.obs)}</div>` : ""}
          ${x.entree ? `<div class="libelle-etat">Sortie</div>` : ""}
          ${segmentEtat(`pieces.${pi}.elements.${xi}`, x.etat)}
          <textarea class="plein auto" rows="1" placeholder="Observations${x.entree ? " de sortie" : ""} (taches, trous, éclats, fonctionnement…)" data-bind="pieces.${pi}.elements.${xi}.obs">${esc(x.obs)}</textarea>
          ${blocPhotos(`pieces.${pi}.elements.${xi}.photos`, x.photos)}</div>`).join("")}
        <div class="element masquer-si-signe ligne">
          <button type="button" data-action="ajout-element" data-pi="${pi}">＋ Élément</button>
          <button type="button" class="danger" data-action="suppr-piece" data-pi="${pi}">Supprimer la pièce</button></div>
      </div></details>`;
    }).join("")}
    <button type="button" class="masquer-si-signe" style="width:100%;justify-content:center;margin-bottom:12px" data-action="ajout-piece">＋ Ajouter une pièce</button>
    <div class="carte"><h2>Observations générales</h2>
      <textarea class="plein auto" rows="3" data-bind="observations" placeholder="Réserves, travaux convenus, équipements fournis…">${esc(e.observations)}</textarea></div>
  </fieldset>
  </main>
  <div class="barre-bas">
    <button data-action="pdf">📄 PDF</button>
    <button class="principal" data-action="signatures">✍︎ Signatures (${nbSig}/${sigs.length})</button>
  </div>`;
  ajusterZones(app);
  chargerVignettes(app);
}

/** Les zones de commentaire s'agrandissent avec leur texte. */
function ajusterHauteur(t) {
  if (!t.offsetParent) return;   // masquée (pièce repliée) : ajustée à l'ouverture
  t.style.height = "auto";
  t.style.height = t.scrollHeight + 2 + "px";
}
const ajusterZones = racine => racine.querySelectorAll("textarea.auto").forEach(ajusterHauteur);

async function chargerVignettes(racine) {
  for (const img of racine.querySelectorAll("img[data-photo-id]:not([src])"))
    img.src = await urlPhoto(img.dataset.photoId);
}

// --- Actions ----------------------------------------------------------------------------------------
async function ouvrirEdl(id) {
  ui.edl = normaliser(await lire("edl", id));
  ui.page = "edl";
  ui.piecesOuvertes.clear();
  ui.pdf = null;
  rendre();
  scrollTo(0, 0);
}

function creerEdl(source, type) {
  const L = source || {};
  const e = {
    id: uid(), cree: new Date().toISOString(), modifie: new Date().toISOString(),
    type, date: aujourdhui(), statut: "brouillon", locataireRef: L.id ?? null,
    bien: L.bien || "", adresse: L.adresse || "",
    logement: [L.logement, ...(L.annexes || [])].filter(Boolean).join(" + "),
    ville: L.ville_signature || reglages.ville,
    dateEntree: L.date_entree || "",
    bailleur: L.bailleur
      ? { nom: L.bailleur, prenom: "", telephone: reglages.telephone || "", email: reglages.email, adresse: L.adresse_bailleur || reglages.adresse }
      : { nom: reglages.nom, prenom: reglages.prenom || "", telephone: reglages.telephone || "", email: reglages.email, adresse: reglages.adresse },
    locataires: [{ ...personneVide(), nom: L.nom || "", email: (L.emails || [])[0] || "" }],
    cautions: [], locatairePrecedent: null,
    compteurs: (L.compteurs || COMPTEURS_DEFAUT.map(n => ({ nom: n, dernier: "" })))
      .map(c => ({ nom: c.nom, numero: "", index: "", dernier: c.dernier || "", photos: [] })),
    cles: CLES.map(n => ({ nom: n, nombre: "" })),
    pieces: (L.pieces || PIECES_DEFAUT).map(nouvellePiece),
    observations: "", signatures: {},
  };
  return e;
}

/** Pour une sortie : reprend pièces, compteurs et clés de l'état des lieux d'entrée, avec l'état constaté. */
function depuisEntree(e, entree) {
  e.pieces = entree.pieces.map(p => ({ id: uid(), nom: p.nom, photos: [], obs: "",
    elements: p.elements.map(x => ({ nom: x.nom, etat: "", obs: "", photos: [], entree: { etat: x.etat, obs: x.obs } })) }));
  e.compteurs = entree.compteurs.map(c => ({ nom: c.nom, numero: c.numero, index: "", photos: [],
    dernier: c.index ? `${c.index} à l'entrée le ${fmtDate(entree.date)}` : c.dernier }));
  e.cles = entree.cles.map(c => ({ nom: c.nom, nombre: "", remis: c.nombre }));
  e.entreeRef = entree.id;
  if (!e.dateEntree) e.dateEntree = entree.date;
  return e;
}

/** Reprend logement, propriétaire, locataires et cautions d'un état des lieux d'entrée. */
function reprendreParties(e, entree) {
  const copie = o => JSON.parse(JSON.stringify(o));
  Object.assign(e, { bien: entree.bien, adresse: entree.adresse, logement: entree.logement, ville: entree.ville,
    locataireRef: entree.locataireRef ?? null, dateEntree: entree.dateEntree || entree.date,
    bailleur: copie(entree.bailleur), locataires: copie(entree.locataires), cautions: copie(entree.cautions || []) });
  return e;
}

async function creerSortieDepuis(entree) {
  const e = depuisEntree(reprendreParties(creerEdl(null, "sortie"), entree), entree);
  await ecrire("edl", e);
  fermerModal();
  ouvrirEdl(e.id);
  toast("État des lieux de sortie créé à partir de l'entrée ✓");
}

async function dialogueNouveau() {
  const locs = donnees ? donnees.locataires : [];
  const edls = await lireTout("edl");
  const m = modal(`
    <h2 style="margin-top:0">Nouvel état des lieux</h2>
    <label class="champ">Locataire
      <select id="n-loc"><option value="">— Saisie libre —</option>
      ${locs.map((l, i) => `<option value="${i}">${esc(l.nom)} · ${esc(l.logement)}${l.date_sortie ? " (sortie " + fmtDate(l.date_sortie) + ")" : ""}</option>`).join("")}
      </select></label>
    <div class="segment" id="n-type" style="margin-bottom:12px">
      <button type="button" class="actif" data-val="entree">Entrée</button><button type="button" data-val="sortie">Sortie</button></div>
    <label class="champ" id="n-reprise-bloc" hidden>Reprendre l'état des lieux d'entrée
      <select id="n-reprise"></select></label>
    <div class="ligne" style="justify-content:flex-end"><button data-ferme>Annuler</button><button class="principal" id="n-ok">Créer</button></div>`);
  let type = "entree";
  const majReprise = () => {
    const L = locs[m.querySelector("#n-loc").value];
    const duLocataire = x => !!L && (x.locataireRef === L.id || x.locataires.some(t => t.nom && (t.nom === L.nom || nomComplet(t) === L.nom)));
    // toutes les entrées, celles du locataire choisi en premier (pré-sélectionnées)
    const entrees = edls.filter(x => x.type === "entree")
      .sort((a, b) => duLocataire(b) - duLocataire(a) || b.date.localeCompare(a.date));
    const bloc = m.querySelector("#n-reprise-bloc");
    bloc.hidden = type !== "sortie" || !entrees.length;
    m.querySelector("#n-reprise").innerHTML = `<option value="">Non, partir d'un modèle vierge</option>` + entrees.map(x =>
      `<option value="${x.id}" ${duLocataire(x) && x === entrees[0] ? "selected" : ""}>${esc(x.locataires.map(nomComplet).filter(Boolean).join(", ") || "Sans nom")}
        – entrée du ${fmtDate(x.date)}${x.logement ? " – " + esc(x.logement) : ""}${x.statut === "signe" ? " (signé)" : ""}</option>`).join("");
  };
  const choisirType = t => {
    type = t;
    m.querySelectorAll("#n-type button").forEach(b => b.classList.toggle("actif", b.dataset.val === t));
    majReprise();
  };
  m.querySelector("#n-type").onclick = ev => ev.target.dataset.val && choisirType(ev.target.dataset.val);
  m.querySelector("#n-loc").onchange = ev => {
    const L = locs[ev.target.value];
    choisirType(L && L.date_sortie ? "sortie" : "entree");
  };
  majReprise();
  m.querySelector("#n-ok").onclick = async () => {
    const L = locs[m.querySelector("#n-loc").value];
    const e = creerEdl(L, type);
    const reprise = type === "sortie" && m.querySelector("#n-reprise").value;
    if (reprise) {
      const entree = edls.find(x => x.id === reprise);
      depuisEntree(e, entree);
      if (!L) reprendreParties(e, entree);   // saisie libre : on reprend aussi les parties de l'entrée
    }
    await ecrire("edl", e);
    fermerModal();
    ouvrirEdl(e.id);
  };
}

async function ajouterPhotos(chemin, fichiers) {
  const fin = attente("Ajout des photos…");
  try {
    const ids = getPath(ui.edl, chemin);
    for (const f of fichiers) {
      const blob = await reduireImage(f, 1600, 0.72);
      const id = uid();
      await ecrire("photos", { id, blob, date: new Date().toISOString(), edl: ui.edl.id });
      ids.push(id);
    }
    sauver(true);
    const ancien = document.getElementById("ph-" + chemin.replace(/\./g, "-"));
    ancien.outerHTML = blocPhotos(chemin, ids);
    chargerVignettes(document);
  } catch (err) {
    alerte("Impossible d'ajouter la photo : " + err.message);
  } finally { fin(); }
}

function reduireImage(fichier, max, qualite) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(fichier);
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * r);
      c.height = Math.round(img.naturalHeight * r);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? ok(b) : ko(new Error("conversion impossible")), "image/jpeg", qualite);
    };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("format d'image non reconnu")); };
    img.src = url;
  });
}

async function voirPhoto(id) {
  const m = modal(`<img src="${await urlPhoto(id)}" style="width:100%;border-radius:10px;display:block">
    <div class="ligne" style="justify-content:flex-end;margin-top:10px"><button data-ferme>Fermer</button></div>`);
  m.querySelector("img").onclick = fermerModal;
}

// --- Modale ------------------------------------------------------------------------------------------
let surFermeture = null;
function modal(html, quandFermee) {
  fermerModal();
  const fond = document.createElement("div");
  fond.className = "modal"; fond.id = "modal";
  fond.innerHTML = `<div class="boite">${html}</div>`;
  fond.addEventListener("click", ev => {
    if (ev.target === fond || ev.target.closest("[data-ferme]")) fermerModal();
  });
  document.body.appendChild(fond);
  surFermeture = quandFermee || null;
  return fond;
}
function fermerModal() {
  const fn = surFermeture;
  surFermeture = null;
  $("#modal")?.remove();
  if (fn) fn();
}

// Remplacent prompt(), confirm() et alert(), bloqués par certains navigateurs et par l'appli installée.
const SUGGESTIONS = {
  element: ["Placard", "Rangements", "Plinthes", "Store", "Volet roulant", "Détecteur de fumée", "Interphone",
    "Miroir", "Radiateur sèche-serviettes", "Lave-linge", "Réfrigérateur", "Lave-vaisselle", "Luminaire"],
  piece: ["Chambre 2", "Chambre 3", "Bureau", "Dégagement", "Salle d'eau", "Cellier", "Buanderie", "Balcon",
    "Terrasse", "Cave", "Garage", "Grenier", "Jardin"],
  compteur: ["Eau froide", "Eau chaude", "Électricité", "Gaz"],
};
function demander(titre, { placeholder = "", suggestions = [], bouton = "Ajouter" } = {}) {
  return new Promise(ok => {
    let reponse = null;
    const m = modal(`<h2 style="margin-top:0">${esc(titre)}</h2>
      <input class="plein" id="d-val" placeholder="${esc(placeholder)}" autocomplete="off">
      ${suggestions.length ? `<div class="ligne" style="margin-top:10px">${suggestions.map(s =>
        `<button type="button" class="puce-choix" data-sugg="${esc(s)}">${esc(s)}</button>`).join("")}</div>` : ""}
      <div class="ligne" style="justify-content:flex-end;margin-top:14px"><button data-ferme>Annuler</button>
        <button class="principal" id="d-ok">${esc(bouton)}</button></div>`, () => ok(reponse));
    const champ = m.querySelector("#d-val");
    const valider = v => { if ((v || "").trim()) { reponse = v.trim(); fermerModal(); } else champ.focus(); };
    m.querySelector("#d-ok").onclick = () => valider(champ.value);
    champ.onkeydown = ev => { if (ev.key === "Enter") valider(champ.value); };
    m.querySelectorAll("[data-sugg]").forEach(b => b.onclick = () => valider(b.dataset.sugg));
    champ.focus();
  });
}
function confirmer(message, bouton = "Supprimer") {
  return new Promise(ok => {
    let reponse = false;
    const m = modal(`<p style="margin-top:4px;white-space:pre-line">${esc(message)}</p>
      <div class="ligne" style="justify-content:flex-end"><button data-ferme>Annuler</button>
        <button class="principal" id="c-ok" style="background:var(--rouge)">${esc(bouton)}</button></div>`, () => ok(reponse));
    m.querySelector("#c-ok").onclick = () => { reponse = true; fermerModal(); };
  });
}
function alerte(message) {
  modal(`<p style="margin-top:4px;white-space:pre-line">${esc(message)}</p>
    <div class="ligne" style="justify-content:flex-end"><button class="principal" data-ferme>OK</button></div>`);
}

// --- Signatures -------------------------------------------------------------------------------------
function dialogueSignatures() {
  const e = ui.edl;
  const sigs = signataires(e);
  const manque = [];
  if (!(e.bailleur.nom || "").trim()) manque.push("le nom du propriétaire");
  if (e.locataires.some(l => !(l.nom || "").trim())) manque.push("le nom du (des) locataire(s)");
  if (e.cautions.some(c => !(c.nom || "").trim())) manque.push("le nom de la (des) caution(s)");
  const nonRemplis = e.pieces.reduce((n, p) => n + p.elements.filter(x => !x.etat).length, 0);
  const m = modal(`
    <h2 style="margin-top:0">Signatures</h2>
    ${manque.length ? `<p style="color:var(--rouge)">Renseignez d'abord ${manque.join(" et ")}.</p>` : ""}
    ${nonRemplis && !verrouille(e) ? `<p style="color:var(--orange)">⚠︎ ${nonRemplis} élément(s) sans état coché.</p>` : ""}
    <p class="doux">Faites relire le document (bouton 📄 PDF) avant de signer. Dès la première signature, le contenu est verrouillé.</p>
    ${sigs.map(s => {
      const sg = e.signatures[s.cle];
      return `<div class="signataire"><div class="etire" style="flex:1"><b>${esc(s.nom || "?")}</b><div class="doux">${s.role}</div>
        ${sg ? `<div class="doux">Signé le ${fmtDate(sg.date)} à ${fmtHeure(sg.date)}</div>` : ""}</div>
        ${sg ? `<span class="signature-ok"><img src="${sg.image}" alt="signature"></span>`
             : `<button class="principal" data-signer="${s.cle}" ${manque.length ? "disabled" : ""}>Signer</button>`}</div>`;
    }).join("")}
    <div class="ligne" style="justify-content:flex-end;margin-top:12px"><button data-ferme>Fermer</button>
      ${e.statut === "signe" ? `<button class="principal" data-action="pdf">📄 PDF et envoi</button>` : ""}</div>`);
  m.querySelectorAll("[data-signer]").forEach(b => b.onclick = () => padSignature(sigs.find(s => s.cle === b.dataset.signer)));
}

function padSignature(s) {
  const e = ui.edl;
  const m = modal(`
    <h2 style="margin-top:0">${esc(s.nom)} <span class="doux">(${s.role})</span></h2>
    <p class="doux" style="margin-top:0">Je reconnais avoir pris connaissance du présent état des lieux de ${libelleType(e)}
      établi contradictoirement le ${fmtDate(e.date)}${s.caution ? ", en qualité de caution" : ""}. <b>Lu et approuvé.</b></p>
    <canvas class="zone-signature"></canvas>
    <div class="ligne" style="margin-top:12px"><button id="s-effacer">Effacer</button><span class="etire"></span>
      <button data-ferme>Annuler</button><button class="principal" id="s-ok" disabled>Valider la signature</button></div>`);
  const c = m.querySelector("canvas"), ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const taille = () => {
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0d2b6b";
  };
  taille();
  let trace = false, vide = true, dernier = null;
  const pos = ev => { const r = c.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  c.onpointerdown = ev => { c.setPointerCapture(ev.pointerId); trace = true; dernier = pos(ev);
    ctx.beginPath(); ctx.arc(dernier[0], dernier[1], 1.2, 0, 7); ctx.fillStyle = "#0d2b6b"; ctx.fill(); };
  c.onpointermove = ev => {
    if (!trace) return;
    const p = pos(ev);
    ctx.beginPath(); ctx.moveTo(...dernier);
    ctx.quadraticCurveTo(dernier[0], dernier[1], (dernier[0] + p[0]) / 2, (dernier[1] + p[1]) / 2);
    ctx.lineTo(...p); ctx.stroke();
    dernier = p;
    if (vide) { vide = false; m.querySelector("#s-ok").disabled = false; }
  };
  c.onpointerup = c.onpointercancel = () => { trace = false; };
  m.querySelector("#s-effacer").onclick = () => { taille(); vide = true; m.querySelector("#s-ok").disabled = true; };
  m.querySelector("#s-ok").onclick = () => {
    if (!c.width || !c.height) { toast("La zone de signature n'est pas prête : fermez et recommencez."); return; }
    e.signatures[s.cle] = { nom: s.nom, role: s.role, date: new Date().toISOString(), image: c.toDataURL("image/png") };
    const toutes = signataires(e).every(x => e.signatures[x.cle]);
    if (toutes) { e.statut = "signe"; e.signeLe = new Date().toISOString(); }
    ui.pdf = null;
    sauver(true);
    rendre();
    dialogueSignatures();
    if (toutes) toast("Toutes les signatures sont recueillies ✓");
  };
}

// --- PDF ---------------------------------------------------------------------------------------------
/** Les polices standard du PDF ne connaissent que l'alphabet latin-1 : on remplace le reste. */
function T(s) {
  return String(s ?? "").replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/œ/g, "oe").replace(/Œ/g, "OE")
    .replace(/[–—]/g, "-").replace(/…/g, "...").replace(/€/g, "EUR").replace(/ /g, " ")
    .replace(/[^\x00-\xFF]/g, "");
}

const couleurEtat = v => v === "Mauvais" ? [198, 40, 40] : v === T("Usé") ? [200, 90, 0] : [20, 20, 20];

function chargerImage(blob) {
  return new Promise((ok, ko) => {
    const lecteur = new FileReader();
    lecteur.onload = () => {
      const img = new Image();
      img.onload = () => ok({ data: lecteur.result, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = ko;
      img.src = lecteur.result;
    };
    lecteur.onerror = ko;
    lecteur.readAsDataURL(blob);
  });
}

async function genererPdf(e) {
  if (!window.jspdf) throw new Error("Le module PDF n'est pas chargé (ouvrez l'appli une fois avec internet).");
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210, H = 297, M = 14, LARG = W - 2 * M;
  const sortie = e.type === "sortie";
  const signe = e.statut === "signe";
  let y = M;

  // Numérotation des photos : chaque section (compteurs, pièce) est suivie de ses propres photos.
  let numero = 0, aDessiner = [];
  const refs = (ids, legende) => (ids || []).map(id => { aDessiner.push({ id, n: ++numero, legende }); return "P" + numero; }).join(", ");

  const titre = sortie ? "ÉTAT DES LIEUX DE SORTIE" : "ÉTAT DES LIEUX D'ENTRÉE";
  doc.setFont("helvetica", "bold"); doc.setFontSize(16);
  doc.text(T(titre), W / 2, y + 4, { align: "center" });
  y += 10;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9);
  doc.text(T(`Établi contradictoirement le ${fmtDate(e.date)} (article 3-2 de la loi n° 89-462 du 6 juillet 1989 et décret n° 2016-382 du 30 mars 2016)`),
    W / 2, y, { align: "center", maxWidth: LARG });
  y += 8;
  if (!signe) {
    doc.setTextColor(198, 40, 40); doc.setFont("helvetica", "bold");
    doc.text(T("PROJET - document non signé"), W / 2, y, { align: "center" });
    doc.setTextColor(0); doc.setFont("helvetica", "normal");
    y += 5;
  }

  const tableau = ({ styles, ...opts }) => {
    doc.autoTable(Object.assign({
      startY: y, theme: "grid", margin: { left: M, right: M }, rowPageBreak: "avoid",
      styles: Object.assign({ font: "helvetica", fontSize: 9, cellPadding: 1.8, lineColor: [160, 160, 160], lineWidth: 0.1,
        textColor: 20, overflow: "linebreak" }, styles),
      headStyles: { fillColor: [236, 239, 241], textColor: 20, fontStyle: "bold" },
    }, opts));
    y = doc.lastAutoTable.finalY + 6;
  };
  const titreSection = (t) => {
    if (y > H - 40) { doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text(T(t), M, y); y += 2;
    doc.setFont("helvetica", "normal");
  };
  /** Photos de la section qui vient d'être écrite, en grille de 3 sous son tableau. */
  const photosSection = async () => {
    const liste = aDessiner;
    aDessiner = [];
    if (!liste.length) return;
    const ecart = 4, lc = (LARG - 2 * ecart) / 3, hmax = 46, hLigne = hmax + 11;
    y -= 2;
    for (let i = 0; i < liste.length; i++) {
      const col = i % 3;
      if (col === 0 && y + hLigne > H - 14) { doc.addPage(); y = M; }
      const rec = await lire("photos", liste[i].id);
      const x = M + col * (lc + ecart);
      if (rec) {
        const img = await chargerImage(rec.blob);
        const r = Math.min(lc / img.w, hmax / img.h);
        doc.addImage(img.data, "JPEG", x, y, img.w * r, img.h * r, undefined, "FAST");
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(60);
        doc.text(T(`P${liste[i].n} - ${liste[i].legende} (${fmtDate(rec.date)} ${fmtHeure(rec.date)})`), x, y + img.h * r + 3.5, { maxWidth: lc });
        doc.setTextColor(0);
      }
      if (col === 2 || i === liste.length - 1) y += hLigne;
    }
    y += 2;
  };

  // Parties : une ligne par personne (rôle | identité et coordonnées)
  const fiche = (p, extra = []) => [
    nomComplet(p) || "-",
    p.naissanceDate || p.naissanceLieu ? `Né(e) le ${fmtDate(p.naissanceDate) || "-"}${p.naissanceLieu ? " à " + p.naissanceLieu : ""}` : "",
    p.adresse || "",
    [p.telephone && `Tél. : ${p.telephone}`, p.email && `Mail : ${p.email}`].filter(Boolean).join("   "),
    ...extra,
  ].filter(Boolean).join("\n");
  const numeroter = (liste, mot) => liste.length > 1 ? (i => `${mot} ${i + 1}`) : (() => mot);
  const roleLoc = numeroter(e.locataires, "Locataire"), roleCau = numeroter(e.cautions, "Caution (garant)");
  const parties = [
    ["Propriétaire", fiche(e.bailleur)],
    ...e.locataires.map((l, i) => [roleLoc(i), fiche(l)]),
    ...e.cautions.map((c, i) => [roleCau(i), fiche(c, c.pour ? [`Se porte caution de ${c.pour}`] : [])]),
    ...(e.locatairePrecedent ? [["Locataire précédent", fiche(e.locatairePrecedent,
      e.locatairePrecedent.dateSortie ? [`Sorti le ${fmtDate(e.locatairePrecedent.dateSortie)}`] : [])]] : []),
    ["Logement", `${e.logement}${e.adresse ? "\n" + e.adresse : ""}\nDate d'entrée dans les lieux : ${fmtDate(e.dateEntree) || "-"}`
      + (sortie ? `\nDate de l'état des lieux de sortie : ${fmtDate(e.date)}` : "")],
  ];
  tableau({
    body: parties.map(r => r.map(T)),
    columnStyles: { 0: { cellWidth: 42, fontStyle: "bold", fillColor: [246, 248, 249] } },
  });

  titreSection("Relevé des compteurs");
  tableau({
    head: [["Compteur", "N° du compteur", "Relevé précédent", "Index relevé ce jour", "Photos"].map(T)],
    body: e.compteurs.map(c => [c.nom, c.numero, c.dernier, c.index, refs(c.photos, `Compteur ${c.nom}`)].map(T)),
  });
  await photosSection();

  titreSection("Clés et accès remis");
  tableau({
    head: [(sortie ? ["Clé / accès", "Remis à l'entrée", "Rendus ce jour"] : ["Clé / accès", "Nombre"]).map(T)],
    body: e.cles.map(c => (sortie ? [c.nom, c.remis ?? "", c.nombre] : [c.nom, c.nombre]).map(T)),
  });

  for (const p of e.pieces) {
    titreSection(p.nom + (p.photos.length ? `   (vue d'ensemble : ${refs(p.photos, "Vue d'ensemble")})` : ""));
    tableau({
      // Sortie : la notation et l'observation d'entrée figurent sous celles de sortie, dans la même case.
      head: [(sortie ? ["Élément", "État\nsortie / entrée", "Observations", "Photos"] : ["Élément", "État", "Observations", "Photos"]).map(T)],
      body: p.elements.map(x => {
        const ph = refs(x.photos, x.nom);
        const etat = x.entree ? `${x.etat || "-"}\nEntrée : ${x.entree.etat || "-"}` : (x.etat || "-");
        const obs = x.entree?.obs ? `${x.obs}${x.obs ? "\n" : ""}Entrée : ${x.entree.obs}` : x.obs;
        return [x.nom, etat, obs, ph].map(T);
      }),
      columnStyles: { 0: { cellWidth: 50 }, 1: { cellWidth: sortie ? 26 : 20 }, 3: { cellWidth: 20 } },
      didParseCell: d => {
        if (d.section === "body" && d.column.index === 1 && sortie) d.cell.styles.textColor = [255, 255, 255]; // dessiné à la main
        else if (d.section === "body" && d.column.index === 1) {
          d.cell.styles.fontStyle = "bold";
          d.cell.styles.textColor = couleurEtat(d.cell.raw);
        }
      },
      didDrawCell: d => {
        if (!sortie || d.section !== "body" || d.column.index !== 1) return;
        // 1re ligne : état de sortie en gras et en couleur ; 2e ligne : état d'entrée en gris
        const [ligneSortie, ligneEntree] = d.cell.text;
        const x = d.cell.x + d.cell.padding("left"), y0 = d.cell.y + d.cell.padding("top") + 3;
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...couleurEtat(ligneSortie));
        doc.text(ligneSortie, x, y0);
        if (ligneEntree) {
          doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(120);
          doc.text(ligneEntree, x, y0 + 4);
        }
        doc.setTextColor(0); doc.setFont("helvetica", "normal"); doc.setFontSize(9);
      },
    });
    await photosSection();
  }

  titreSection("Observations générales");
  tableau({ body: [[T(e.observations || " ")]], styles: { minCellHeight: 18, fontSize: 9, cellPadding: 2 } });
  if (sortie) {
    doc.setFontSize(8.5);
    doc.text(T("Seules les dégradations excédant l'usure normale (vétusté) peuvent être retenues sur le dépôt de garantie."), M, y - 2, { maxWidth: LARG });
    y += 4;
  }

  // Signatures
  const sigs = signataires(e);
  const hauteurSig = 48, nbLignes = Math.ceil(sigs.length / 2);
  if (y + 14 + nbLignes * (hauteurSig + 4) > H - 14) { doc.addPage(); y = M; }
  doc.setFontSize(10);
  doc.text(T(`Fait à ${e.ville || "................"}, le ${fmtDate(e.date)}. Le présent état des lieux, signé électroniquement par les parties, ` +
    `est remis à chacune d'elles au format PDF.`), M, y, { maxWidth: LARG });
  y += 10;
  const largSig = (LARG - 6) / 2;
  sigs.forEach((s, i) => {
    const x = M + (i % 2) * (largSig + 6), yy = y + Math.floor(i / 2) * (hauteurSig + 4);
    const sg = e.signatures[s.cle];
    doc.setDrawColor(160); doc.rect(x, yy, largSig, hauteurSig);
    doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
    doc.text(T(`${s.role} : ${s.nom}`), x + 3, yy + 5, { maxWidth: largSig - 6 });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    doc.text(T('"Lu et approuvé"'), x + 3, yy + 10);
    if (sg) {
      try { doc.addImage(sg.image, "PNG", x + 3, yy + 12, largSig - 6, 26, undefined, "FAST"); }
      catch (_) { doc.text(T("(image de signature illisible)"), x + 3, yy + 24); }
      doc.setFontSize(7.5); doc.setTextColor(90);
      doc.text(T(`Signé le ${fmtDate(sg.date)} à ${fmtHeure(sg.date)}`), x + 3, yy + hauteurSig - 3);
      doc.setTextColor(0);
    }
  });
  y += nbLignes * (hauteurSig + 4);

  // Pied de page
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(110);
    doc.text(T(`État des lieux de ${libelleType(e)} - ${e.logement} - ${e.locataires.map(nomComplet).join(", ")}`), M, H - 7, { maxWidth: LARG - 30 });
    doc.text(`${i} / ${n}`, W - M, H - 7, { align: "right" });
    doc.setTextColor(0);
  }
  return doc.output("blob");
}

function nomFichier(e) {
  const propre = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w .-]+/g, "_").trim();
  return `Etat des lieux ${e.type === "sortie" ? "sortie" : "entree"} - ${propre(e.locataires.map(nomComplet).filter(Boolean).join(" et ") || "locataire")} - ${e.date}.pdf`;
}

const destinataires = e => [...e.locataires.map(l => l.email), ...e.cautions.map(c => c.email), e.bailleur.email].map(s => (s || "").trim()).filter(Boolean);

async function dialoguePdf() {
  const e = ui.edl;
  const fin = attente("Création du PDF…");
  try {
    if (!ui.pdf || ui.pdf.modifie !== e.modifie) {
      const blob = await genererPdf(e);
      ui.pdf = { modifie: e.modifie, fichier: new File([blob], nomFichier(e), { type: "application/pdf" }) };
    }
  } catch (err) {
    fin();
    alerte("Erreur lors de la création du PDF : " + err.message);
    return;
  }
  fin();
  const f = ui.pdf.fichier, dest = destinataires(e);
  const signe = e.statut === "signe";
  const m = modal(`
    <h2 style="margin-top:0">PDF ${signe ? "signé" : "(projet non signé)"}</h2>
    <p class="doux">${esc(f.name)} · ${(f.size / 1048576).toFixed(1)} Mo</p>
    ${f.size > 20 * 1048576 ? `<p style="color:var(--orange)">⚠︎ Fichier volumineux : certains serveurs de mail refusent plus de 20 Mo. Retirez quelques photos si l'envoi échoue.</p>` : ""}
    <button style="width:100%;justify-content:center;margin-bottom:8px" id="p-voir">👁 Aperçu</button>
    ${signe ? `
    <label class="champ">Destinataires<input class="plein" id="p-dest" value="${esc(dest.join(", "))}"></label>
    <button class="principal" style="width:100%;justify-content:center;padding:12px" id="p-envoyer">✉︎ Envoyer par mail</button>
    <p class="doux">Choisissez « Mail » dans le menu de partage : les adresses ci-dessus sont copiées, collez-les dans le champ « À ».</p>`
    : `<p class="doux">L'envoi par mail est proposé une fois que toutes les parties ont signé.</p>`}
    <div class="ligne" style="justify-content:flex-end"><button data-ferme>Fermer</button></div>`);
  m.querySelector("#p-voir").onclick = () => {
    const url = URL.createObjectURL(f);
    window.open(url, "_blank") || (location.href = url);
  };
  const env = m.querySelector("#p-envoyer");
  if (env) env.onclick = async () => {
    const liste = m.querySelector("#p-dest").value;
    try { await navigator.clipboard.writeText(liste); } catch (_) { /* presse-papiers refusé */ }
    const sujet = `État des lieux de ${libelleType(e)} – ${e.logement}`;
    const texte = `Bonjour,\n\nVeuillez trouver ci-joint l'état des lieux de ${libelleType(e)} du ${fmtDate(e.date)} ` +
      `(${e.logement}${e.adresse ? ", " + e.adresse : ""}), signé par les parties.\n\nCordialement,\n${nomComplet(e.bailleur)}`;
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try {
        await navigator.share({ files: [f], title: sujet, text: texte });
        e.envoyeLe = new Date().toISOString(); sauver(true);
      } catch (err) {
        if (err.name !== "AbortError") alerte("Partage impossible : " + err.message);
      }
    } else {
      // Ordinateur : téléchargement du PDF + ouverture du logiciel de mail
      const a = document.createElement("a");
      a.href = URL.createObjectURL(f); a.download = f.name; a.click();
      location.href = `mailto:${encodeURIComponent(liste)}?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(texte + "\n\n(PDF à joindre : " + f.name + ")")}`;
    }
  };
}

// --- Événements ---------------------------------------------------------------------------------------
document.addEventListener("input", ev => {
  const t = ev.target;
  if (t.matches("textarea.auto")) ajusterHauteur(t);
  if (t.dataset.bind && ui.edl) {
    setPath(ui.edl, t.dataset.bind, t.value);
    ui.pdf = null;
    sauver();
  } else if (t.dataset.reglage) {
    reglages[t.dataset.reglage] = t.value;
    ecrireKV("reglages", reglages);
  }
});

document.addEventListener("toggle", ev => {
  const d = ev.target;
  if (d.dataset?.piece) d.open ? ui.piecesOuvertes.add(d.dataset.piece) : ui.piecesOuvertes.delete(d.dataset.piece);
  if (d.open) ajusterZones(d);
}, true);

document.addEventListener("change", async ev => {
  const t = ev.target;
  if (t.dataset.photos && t.files.length) {
    await ajouterPhotos(t.dataset.photos, [...t.files]);
  } else if (t.dataset.action === "importer" && t.files[0]) {
    try {
      const d = JSON.parse(await t.files[0].text());
      if (d.format !== "edl-iphone") throw new Error("ce fichier ne vient pas du logiciel de gestion");
      d.importe_le = new Date().toISOString();
      donnees = d;
      await ecrireKV("donnees", d);
      toast(`${d.locataires.length} locataire(s) importé(s) ✓`);
      rendre();
    } catch (err) { alerte("Import impossible : " + err.message); }
  }
});

document.addEventListener("click", async ev => {
  const seg = ev.target.closest("[data-etat] button");
  if (seg && ui.edl && !verrouille(ui.edl)) {
    const chemin = seg.parentElement.dataset.etat, el = getPath(ui.edl, chemin);
    el.etat = el.etat === seg.dataset.val ? "" : seg.dataset.val;
    seg.parentElement.querySelectorAll("button").forEach(b => b.className = b.dataset.val === el.etat ? "actif e-" + el.etat : "");
    const piece = seg.closest("details"), p = ui.edl.pieces.find(x => x.id === piece.dataset.piece);
    const faits = p.elements.filter(x => x.etat).length, puce = piece.querySelector("summary .puce");
    puce.textContent = `${faits}/${p.elements.length}`;
    puce.classList.toggle("signe", faits === p.elements.length);
    ui.pdf = null; sauver();
    return;
  }
  const typ = ev.target.closest("[data-type] button");
  if (typ && ui.edl && !verrouille(ui.edl)) { ui.edl.type = typ.dataset.val; ui.pdf = null; sauver(); rendre(); return; }

  const b = ev.target.closest("[data-action]");
  if (!b || b.tagName === "INPUT") return;
  const e = ui.edl, a = b.dataset.action;
  const structure = (fn) => { fn(); ui.pdf = null; sauver(true); rendre(); };
  switch (a) {
    case "accueil": sauver(true); ui.page = "accueil"; ui.edl = null; fermerModal(); rendre(); break;
    case "reglages": ui.page = "reglages"; rendre(); break;
    case "nouveau": dialogueNouveau(); break;
    case "ouvrir": ouvrirEdl(b.dataset.id); break;
    case "voir-photo": voirPhoto(b.dataset.id); break;
    case "suppr-photo":
      if (await confirmer("Supprimer cette photo ?")) {
        const ids = getPath(e, b.dataset.chemin), [id] = ids.splice(+b.dataset.i, 1);
        await effacer("photos", id);
        structure(() => {});
      }
      break;
    case "suppr": {
      const liste = getPath(e, b.dataset.chemin), x = liste[+b.dataset.i];
      if (await confirmer(`Retirer « ${x.nom || "cet élément"} »${idsPhotos(x).length ? " et ses photos" : ""} ?`, "Retirer")) {
        for (const id of idsPhotos(x)) await effacer("photos", id);
        structure(() => liste.splice(+b.dataset.i, 1));
      }
      break;
    }
    case "ajout-locataire": structure(() => e.locataires.push(personneVide())); break;
    case "ajout-caution": structure(() => e.cautions.push({ ...personneVide(), adresse: "", pour: "" })); break;
    case "ajout-precedent": structure(() => e.locatairePrecedent = { nom: "", prenom: "", telephone: "", email: "", dateSortie: "" }); break;
    case "suppr-precedent":
      if (await confirmer("Retirer la section « Locataire précédent » ?", "Retirer")) structure(() => e.locatairePrecedent = null);
      break;
    case "ajout-cle": structure(() => e.cles.push({ nom: "", nombre: "" })); break;
    case "ajout-compteur": {
      const presents = e.compteurs.map(c => c.nom);
      const nom = await demander("Ajouter un compteur", { placeholder: "Nom du compteur",
        suggestions: SUGGESTIONS.compteur.filter(s => !presents.includes(s)) });
      if (nom) structure(() => e.compteurs.push({ nom, numero: "", index: "", dernier: "", photos: [] }));
      break;
    }
    case "ajout-piece": {
      const presents = e.pieces.map(p => p.nom);
      const nom = await demander("Ajouter une pièce", { placeholder: "Nom de la pièce",
        suggestions: SUGGESTIONS.piece.filter(s => !presents.includes(s)) });
      if (nom) structure(() => { const p = nouvellePiece(nom); e.pieces.push(p); ui.piecesOuvertes.add(p.id); });
      break;
    }
    case "ajout-element": {
      const p = e.pieces[+b.dataset.pi], presents = p.elements.map(x => x.nom);
      const nom = await demander(`Ajouter un élément – ${p.nom}`, { placeholder: "Nom de l'élément",
        suggestions: SUGGESTIONS.element.filter(s => !presents.includes(s)) });
      if (nom) structure(() => p.elements.push({ nom, etat: "", obs: "", photos: [] }));
      break;
    }
    case "suppr-piece": {
      const p = e.pieces[+b.dataset.pi];
      if (await confirmer(`Supprimer la pièce « ${p.nom} » et ses photos ?`)) {
        for (const id of [...p.photos, ...p.elements.flatMap(x => x.photos)]) await effacer("photos", id);
        structure(() => e.pieces.splice(+b.dataset.pi, 1));
      }
      break;
    }
    case "signatures": dialogueSignatures(); break;
    case "pdf": dialoguePdf(); break;
    case "deverrouiller":
      if (await confirmer("Modifier l'état des lieux efface toutes les signatures déjà recueillies : chaque partie devra signer à nouveau.", "Effacer les signatures"))
        structure(() => { e.signatures = {}; e.statut = "brouillon"; delete e.signeLe; });
      break;
    case "menu-edl": {
      const m = modal(`<h2 style="margin-top:0">${esc(nomComplet(e.locataires[0]) || "État des lieux")}</h2>
        ${e.type === "entree" ? `<button class="principal" style="width:100%;justify-content:center;margin-bottom:8px" id="m-sortie">
          Créer l'état des lieux de sortie</button>
          <p class="doux" style="margin:0 0 12px">Reprend les parties, les pièces et les clés ; chaque notation d'entrée s'affiche sous celle de sortie.</p>` : ""}
        <button style="width:100%;justify-content:center;margin-bottom:8px" id="m-dup">Dupliquer (nouveau brouillon)</button>
        <button class="danger" style="width:100%;justify-content:center;margin-bottom:8px" id="m-suppr">Supprimer cet état des lieux</button>
        <div class="ligne" style="justify-content:flex-end"><button data-ferme>Fermer</button></div>`);
      m.querySelector("#m-sortie")?.addEventListener("click", () => { sauver(true); creerSortieDepuis(e); });
      m.querySelector("#m-suppr").onclick = async () => {
        if (!await confirmer("Supprimer définitivement cet état des lieux et toutes ses photos ?" + (e.statut === "signe" && !e.envoyeLe ? "\n\nAttention : il est signé mais n'a pas été envoyé par mail." : ""))) return;
        const tous = [...e.compteurs.flatMap(c => c.photos), ...e.pieces.flatMap(p => [...p.photos, ...p.elements.flatMap(x => x.photos)])];
        for (const id of tous) await effacer("photos", id);
        await effacer("edl", e.id);
        ui.edl = null; ui.page = "accueil"; fermerModal(); rendre();
      };
      m.querySelector("#m-dup").onclick = async () => {
        const copie = JSON.parse(JSON.stringify(e));
        Object.assign(copie, { id: uid(), cree: new Date().toISOString(), modifie: new Date().toISOString(), statut: "brouillon", signatures: {} });
        delete copie.signeLe; delete copie.envoyeLe;
        // les photos ne sont pas partagées entre deux états des lieux
        copie.compteurs.forEach(c => c.photos = []);
        copie.pieces.forEach(p => { p.photos = []; p.elements.forEach(x => x.photos = []); });
        await ecrire("edl", copie);
        fermerModal(); ouvrirEdl(copie.id);
      };
      break;
    }
  }
});

// --- Démarrage ----------------------------------------------------------------------------------------
(async () => {
  reglages = Object.assign(reglages, await lireKV("reglages", {}));
  donnees = await lireKV("donnees", null);
  try { navigator.storage?.persist?.(); } catch (_) { /* facultatif */ }
  rendre();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
})();
