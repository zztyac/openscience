import type { useLanguage } from "@/context/language"
import type { Service } from "./credential-loader"

type Translate = ReturnType<typeof useLanguage>["t"]
type Group = { id: string; label: string; description: string; domains: string[] }

const groups = {
  "package-management": {
    label: "settings.copy.catalog.network.package-management.label",
    description: "settings.copy.catalog.network.package-management.description",
  },
  "ncbi-nih": {
    label: "settings.copy.catalog.network.ncbi-nih.label",
    description: "settings.copy.catalog.network.ncbi-nih.description",
  },
  "genomics-biology": {
    label: "settings.copy.catalog.network.genomics-biology.label",
    description: "settings.copy.catalog.network.genomics-biology.description",
  },
  proteomics: {
    label: "settings.copy.catalog.network.proteomics.label",
    description: "settings.copy.catalog.network.proteomics.description",
  },
  "literature-citations": {
    label: "settings.copy.catalog.network.literature-citations.label",
    description: "settings.copy.catalog.network.literature-citations.description",
  },
  "chemistry-pharma": {
    label: "settings.copy.catalog.network.chemistry-pharma.label",
    description: "settings.copy.catalog.network.chemistry-pharma.description",
  },
  "omics-atlases": {
    label: "settings.copy.catalog.network.omics-atlases.label",
    description: "settings.copy.catalog.network.omics-atlases.description",
  },
  "clinical-regulatory": {
    label: "settings.copy.catalog.network.clinical-regulatory.label",
    description: "settings.copy.catalog.network.clinical-regulatory.description",
  },
} as const
const services = {
  aws: "settings.copy.catalog.service.aws",
  github: "settings.copy.catalog.service.github",
  gcp: "settings.copy.catalog.service.gcp",
  literature: "settings.copy.catalog.service.literature",
  firecrawl: "settings.copy.catalog.service.firecrawl",
  azure: "settings.copy.catalog.service.azure",
  nvidia: "settings.copy.catalog.service.nvidia",
  nvidia_ngc: "settings.copy.catalog.service.nvidia_ngc",
  openalex: "settings.copy.catalog.service.openalex",
  huggingface: "settings.copy.catalog.service.huggingface",
  tinker: "settings.copy.catalog.service.tinker",
  wandb: "settings.copy.catalog.service.wandb",
  pinecone: "settings.copy.catalog.service.pinecone",
  langsmith: "settings.copy.catalog.service.langsmith",
} as const
const fields = {
  "Access key ID": "settings.copy.catalog.field.accesskeyid",
  "Secret access key": "settings.copy.catalog.field.secretaccesskey",
  "Default region": "settings.copy.catalog.field.defaultregion",
  "Access token": "settings.copy.catalog.field.accesstoken",
  "Project ID": "settings.copy.catalog.field.projectid",
  "Service account JSON": "settings.copy.catalog.field.serviceaccountjson",
  "API key": "settings.copy.catalog.field.apikey",
  "Tenant ID": "settings.copy.catalog.field.tenantid",
  "Client ID": "settings.copy.catalog.field.clientid",
  "Client secret": "settings.copy.catalog.field.clientsecret",
  "Subscription ID": "settings.copy.catalog.field.subscriptionid",
  Endpoint: "settings.copy.catalog.field.endpoint",
  "NGC API key": "settings.copy.catalog.field.ngcapikey",
  "Contact email": "settings.copy.catalog.field.contactemail",
  "Base URL": "settings.copy.catalog.field.baseurl",
} as const

// Only built-in catalog entries have translation keys. Custom and future
// server entries retain the names and descriptions supplied by their owner.
export function networkGroupCopy(group: Group, t: Translate): Group {
  if (!Object.hasOwn(groups, group.id)) return group
  const keys = groups[group.id as keyof typeof groups]
  return { ...group, label: t(keys.label), description: t(keys.description) }
}

export function credentialServiceCopy(service: Service, t: Translate): Service {
  if (service.custom || !Object.hasOwn(services, service.id)) return service
  return {
    ...service,
    label: service.id === "literature" ? t("settings.copy.catalog.literature") : service.label,
    description: t(services[service.id as keyof typeof services]),
    fields: service.fields.map((field) => ({
      ...field,
      label: Object.hasOwn(fields, field.label) ? t(fields[field.label as keyof typeof fields]) : field.label,
    })),
  }
}

const scienceSummaries = {
  scipy: "settings.copy.science.summary.scipy",
  matplotlib: "settings.copy.science.summary.matplotlib",
  "scikit-learn": "settings.copy.science.summary.scikit-learn",
  biopython: "settings.copy.science.summary.biopython",
  rdkit: "settings.copy.science.summary.rdkit",
  boltz2: "settings.copy.science.summary.boltz2",
  diffdock: "settings.copy.science.summary.diffdock",
  evo2: "settings.copy.science.summary.evo2",
  genmol: "settings.copy.science.summary.genmol",
  molmim: "settings.copy.science.summary.molmim",
  "msa-search": "settings.copy.science.summary.msa-search",
  openfold2: "settings.copy.science.summary.openfold2",
  openfold3: "settings.copy.science.summary.openfold3",
  proteinmpnn: "settings.copy.science.summary.proteinmpnn",
  rfdiffusion: "settings.copy.science.summary.rfdiffusion",
} as const

const scienceCategories = {
  analysis: "settings.copy.science.category.analysis",
  visualization: "settings.copy.science.category.visualization",
  bioinformatics: "settings.copy.science.category.bioinformatics",
  cheminformatics: "settings.copy.science.category.cheminformatics",
  structure: "settings.copy.science.category.structure",
  docking: "settings.copy.science.category.docking",
  genomics: "settings.copy.science.category.genomics",
  protein_design: "settings.copy.science.category.protein_design",
} as const

export function scientificSummaryCopy(record: { id: string; summary: string }, t: Translate) {
  return Object.hasOwn(scienceSummaries, record.id)
    ? t(scienceSummaries[record.id as keyof typeof scienceSummaries])
    : record.summary
}
export function scientificCategoryCopy(category: string, t: Translate) {
  if (Object.hasOwn(scienceCategories, category))
    return t(scienceCategories[category as keyof typeof scienceCategories])
  const label = category.replaceAll("_", " ")
  return label.charAt(0).toUpperCase() + label.slice(1)
}
