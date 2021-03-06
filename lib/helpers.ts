import _ from 'lodash';
import { NextRouter } from 'next/router';
import fetch from 'node-fetch';
import * as Path from 'path';
import { toArabic } from 'roman-numerals';

import { WPAtlas } from '../types';
import {
    ExploreOptionType,
    ExploreSelectedFilter,
    SynapseAtlas,
    SynapseData,
    SynapseSchema,
} from './types';
import { ExploreURLQuery } from '../pages/explore';
import { ExploreTab } from '../components/ExploreTabs';

// @ts-ignore
let win;

if (typeof window !== 'undefined') {
    win = window as any;
} else {
    win = {} as any;
}

export function extractEntitiesFromSynapseData(data: SynapseData): Entity[] {
    const schemasByName = _.keyBy(data.schemas, (s) => s.data_schema);
    const entities: Entity[] = [];
    _.forEach(data.atlases, (atlas: SynapseAtlas) => {
        _.forEach(atlas, (synapseRecords, key) => {
            if (key === 'htan_id' || key === 'htan_name') {
                // skip these
                return;
            }
            const schemaName = synapseRecords.data_schema;
            if (schemaName) {
                const schema = schemasByName[schemaName];

                synapseRecords.record_list.forEach((record) => {
                    const entity: Partial<Entity> = {};

                    schema.attributes.forEach(
                        (f: SynapseSchema['attributes'][0], i: number) => {
                            entity[f.id.replace(/^bts:/, '') as keyof Entity] =
                                record.values[i];
                        }
                    );

                    entity.atlasid = atlas.htan_id;

                    entities.push(entity as Entity);
                });
            }
        });
    });

    return entities;
}

export interface Entity {
    // Synapse attribute names
    AJCCPathologicStage: string;
    Biospecimen: string;
    Component: string;
    HTANParentID: string;
    HTANBiospecimenID: string;
    HTANDataFileID: string;
    HTANParentBiospecimenID: string;
    HTANParentDataFileID: string;
    TissueorOrganofOrigin: string;
    PrimaryDiagnosis: string;
    AgeatDiagnosis: number;
    fileFormat: string;
    filename: string;
    HTANParticipantID: string;
    ImagingAssayType?: string;
    AssayType?: string;

    // Derived or attached in frontend
    atlas: Atlas;
    atlasid: string;
    level: string;
    assayName?: string;
    WPAtlas: WPAtlas;
    biospecimen: Entity[];
    diagnosis: Entity[];
    demographics: Entity[];
    cases: Entity[];
    primaryParents?: Entity[];
    synapseId?: string;
}

export interface Atlas {
    htan_id: string;
    htan_name: string;
    num_cases: number;
    num_biospecimens: number;
    WPAtlas: WPAtlas;
}

export interface LoadDataResult {
    files: Entity[];
    atlases: Atlas[];
}

win.missing = [];

function doesFileHaveMultipleParents(file: Entity) {
    return /Level[456]/.test(file.Component);
}

export function doesFileIncludeLevel1OrLevel2SequencingData(file: Entity) {
    return (
        !file.Component.startsWith('Imaging') &&
        (file.level === 'Level 1' || file.level === 'Level 2')
    );
}

function findAndAddPrimaryParents(
    f: Entity,
    filesByFileId: { [HTANDataFileID: string]: Entity }
): Entity[] {
    if (f.primaryParents) {
        // recursive optimization:
        //  if we've already calculated f.primaryParents, just return it
        return f.primaryParents;
    }

    // otherwise, compute parents
    let primaryParents: Entity[] = [];

    if (f.HTANParentDataFileID) {
        // if there's a parent, traverse "upwards" to find primary parent
        const parentIds = f.HTANParentDataFileID.split(/[,;]/);
        const parentFiles = parentIds.reduce((aggr: Entity[], id: string) => {
            const file = filesByFileId[id];
            if (file) {
                aggr.push(file);
            } else {
                // @ts-ignore
                (win as any).missing.push(id);
            }
            return aggr;
        }, []);

        primaryParents = _(parentFiles)
            .map((f) => findAndAddPrimaryParents(f, filesByFileId))
            .flatten()
            .uniqBy((f) => f.HTANDataFileID)
            .value();

        // add primaryParents member to child file
        f.primaryParents = primaryParents;
    }
    {
        // else
        // recursive base case: parent (has no parent itself)
        primaryParents = [f];

        // we don't add primaryParents member to the parent file
    }

    return primaryParents;
}

function addPrimaryParents(files: Entity[]) {
    const fileIdToFile = _.keyBy(files, (f) => f.HTANDataFileID);

    files.forEach((f) => {
        findAndAddPrimaryParents(f, fileIdToFile);
    });
}

function getCaseData(
    biospecimen: Entity[],
    biospecimenByHTANBiospecimenID: { [htanBiospecimenID: string]: Entity },
    casesByHTANParticipantID: { [htanParticipantID: string]: Entity }
) {
    return biospecimen
        .map((s) => {
            // HTANParentID can be both participant or biospecimen, so keep
            // going up the tree until participant is found.
            let HTANParentID = s.HTANParentID;
            while (HTANParentID in biospecimenByHTANBiospecimenID) {
                const parentBioSpecimen =
                    biospecimenByHTANBiospecimenID[HTANParentID];
                HTANParentID = parentBioSpecimen.HTANParentID;
            }
            if (!(HTANParentID in casesByHTANParticipantID)) {
                console.error(
                    `${s.HTANBiospecimenID} does not have a HTANParentID with diagnosis information`
                );
                return undefined;
            } else {
                return casesByHTANParticipantID[HTANParentID] as Entity;
            }
        })
        .filter((f) => !!f) as Entity[];
}

function getSampleAndPatientData(
    file: Entity,
    biospecimenByHTANBiospecimenID: { [htanBiospecimenID: string]: Entity },
    diagnosisByHTANParticipantID: { [htanParticipantID: string]: Entity },
    demographicsByHTANParticipantID: { [htanParticipantID: string]: Entity }
) {
    const primaryParents =
        file.primaryParents && file.primaryParents.length
            ? file.primaryParents
            : [file];

    const biospecimen = primaryParents
        .map((p) =>
            p.HTANParentBiospecimenID.split(',').map(
                (HTANParentBiospecimenID) =>
                    biospecimenByHTANBiospecimenID[HTANParentBiospecimenID] as
                        | Entity
                        | undefined
            )
        )
        .flat()
        .filter((f) => !!f) as Entity[];

    const diagnosis = getCaseData(
        biospecimen,
        biospecimenByHTANBiospecimenID,
        diagnosisByHTANParticipantID
    );

    const demographics = getCaseData(
        biospecimen,
        biospecimenByHTANBiospecimenID,
        demographicsByHTANParticipantID
    );

    const cases = mergeCaseData(diagnosis, demographicsByHTANParticipantID);

    return { biospecimen, diagnosis, demographics, cases };
}

function mergeCaseData(
    diagnosis: Entity[],
    demographicsByHTANParticipantID: { [htanParticipantID: string]: Entity }
) {
    return diagnosis.map((d) => ({
        ...d,
        ...demographicsByHTANParticipantID[d.HTANParticipantID],
    }));
}

export async function loadData(
    WPAtlasData: WPAtlas[]
): Promise<LoadDataResult> {
    const url = '/syn_data.json'; // '/sim.json';

    const data: SynapseData = await fetch(url).then((r) => r.json());

    return processSynapseJSON(data, WPAtlasData);
}

function extractBiospecimensAndDiagnosisAndDemographics(data: Entity[]) {
    const biospecimenByHTANBiospecimenID: {
        [htanBiospecimenID: string]: Entity;
    } = {};
    const diagnosisByHTANParticipantID: {
        [htanParticipantID: string]: Entity;
    } = {};
    const demographicsByHTANParticipantID: {
        [htanParticipantID: string]: Entity;
    } = {};

    data.forEach((entity) => {
        if (entity.Component === 'Biospecimen') {
            biospecimenByHTANBiospecimenID[entity.HTANBiospecimenID] = entity;
        }
        if (entity.Component === 'Diagnosis') {
            diagnosisByHTANParticipantID[entity.HTANParticipantID] = entity;
        }
        if (entity.Component === 'Demographics') {
            demographicsByHTANParticipantID[entity.HTANParticipantID] = entity;
        }
    });

    return {
        biospecimenByHTANBiospecimenID,
        diagnosisByHTANParticipantID,
        demographicsByHTANParticipantID,
    };
}

export function processSynapseJSON(synapseJson: any, WPAtlasData: WPAtlas[]) {
    const flatData: Entity[] = extractEntitiesFromSynapseData(synapseJson);

    const files = flatData.filter((obj) => {
        return !!obj.filename;
    });

    addPrimaryParents(files);
    const {
        biospecimenByHTANBiospecimenID,
        diagnosisByHTANParticipantID,
        demographicsByHTANParticipantID,
    } = extractBiospecimensAndDiagnosisAndDemographics(flatData);

    const WPAtlasMap = _.keyBy(WPAtlasData, (a) => a.htan_id.toUpperCase());

    const synapseAtlasMap = _.keyBy(synapseJson.atlases, (a) => a.htan_id);

    // tag synapse atlas with WP atlas
    _.forEach(synapseAtlasMap, (a: Atlas) => {
        if (WPAtlasMap[a.htan_id]) {
            a.WPAtlas = WPAtlasMap[a.htan_id] || undefined;
        }
    });

    _.forEach(files, (file) => {
        // parse component to make a new level property and adjust component property
        if (file.Component) {
            const parsedAssay = parseRawAssayType(
                file.Component,
                file.ImagingAssayType
            );
            //file.Component = parsed.name;
            if (parsedAssay.level && parsedAssay.level.length > 1) {
                file.level = parsedAssay.level;
            } else {
                file.level = 'Unknown';
            }
            file.assayName = parsedAssay.name;

            // special case for Other Assay.  These are assays that don't fit
            // the standard model.  To have a more descriptive name use assay
            // type field instead
            if (parsedAssay.name === 'Other Assay') {
                file.assayName = file.AssayType || 'Other Assay';
                file.level = 'Other';
            }
        } else {
            file.level = 'Unknown';
        }

        file.WPAtlas = WPAtlasMap[file.atlasid.split('_')[0]];

        file.atlas = synapseAtlasMap[file.atlasid];

        const parentData = getSampleAndPatientData(
            file,
            biospecimenByHTANBiospecimenID,
            diagnosisByHTANParticipantID,
            demographicsByHTANParticipantID
        );

        file.biospecimen = parentData.biospecimen;
        file.diagnosis = parentData.diagnosis;
        file.demographics = parentData.demographics;
        file.cases = parentData.cases;
    });

    // files must have a diagnosis
    const returnFiles = files.filter((f) => !!f.diagnosis);

    // atlases MUST have an entry in WPAtlas
    const returnAtlases = synapseJson.atlases.filter((a: Atlas) => a.WPAtlas);

    // count cases and biospecimens for each atlas
    const filesByAtlas = _.groupBy(returnFiles, (f) => f.atlasid);
    const caseCountByAtlas = _.mapValues(filesByAtlas, (files) => {
        return _.chain(files)
            .flatMapDeep((f) => f.diagnosis)
            .uniqBy((f) => f.HTANParticipantID)
            .value().length;
    });
    const biospecimenCountByAtlas = _.mapValues(filesByAtlas, (files) => {
        return _.chain(files)
            .flatMapDeep((f) => f.biospecimen)
            .uniqBy((f) => f.HTANBiospecimenID)
            .value().length;
    });

    returnAtlases.forEach((a: Atlas) => {
        a.num_biospecimens = biospecimenCountByAtlas[a.htan_id];
        a.num_cases = caseCountByAtlas[a.htan_id];
    });

    // filter out files without a diagnosis
    return { files: returnFiles, atlases: returnAtlases };
}

export function sortStageOptions(options: ExploreOptionType[]) {
    const sortedOptions = _.sortBy(options, (option) => {
        const numeral = option.value.match(/stage ([IVXLCDM]+)/i);
        let val = undefined;
        if (!!numeral && numeral.length > 1) {
            try {
                const number = toArabic(numeral[1]);
            } catch (ex) {
                val = numeral[1];
            }
        }
        return option.label;
    });

    const withStage = sortedOptions.filter((option) =>
        /stage/i.test(option.label)
    );
    const withoutStage = sortedOptions.filter(
        (option) => !/stage/i.test(option.label)
    );

    return withStage.concat(withoutStage);

    //return options;
}

export function clamp(x: number, lower: number, upper: number) {
    return Math.max(lower, Math.min(x, upper));
}

export function parseRawAssayType(
    componentName: string,
    imagingAssayType?: string
) {
    // It comes in the form bts:CamelCase-NameLevelX (may or may not have that hyphen).
    // We want to take that and spit out { name: "Camel Case-Name", level: "Level X" }
    //  (with the exception that the prefixes Sc and Sn are always treated as lower case)

    // See if there's a Level in it
    const splitByLevel = componentName.split('Level');
    const level = splitByLevel.length > 1 ? `Level ${splitByLevel[1]}` : null;
    const extractedName = splitByLevel[0];

    if (imagingAssayType) {
        // do not parse imaging assay type, use as is
        return { name: imagingAssayType, level };
    }

    if (extractedName) {
        // Convert camel case to space case
        // Source: https://stackoverflow.com/a/15370765
        let name = extractedName.replace(
            /([A-Z])([A-Z])([a-z])|([a-z])([A-Z])/g,
            '$1$4 $2$3$5'
        );

        // special case: sc as prefix
        name = name.replace(/\bSc /g, 'sc');

        // special case: sn as prefix
        name = name.replace(/\bSn /g, 'sn');

        return { name, level };
    }

    // Couldn't parse
    return { name: componentName, level: null };
}

export function urlEncodeSelectedFilters(
    selectedFilters: ExploreSelectedFilter[]
) {
    return JSON.stringify(selectedFilters);
}
export function parseSelectedFiltersFromUrl(
    selectedFiltersURLQueryParam: string | undefined
): ExploreSelectedFilter[] | null {
    if (selectedFiltersURLQueryParam) {
        return JSON.parse(selectedFiltersURLQueryParam);
    }
    return null;
}

function addQueryStringToURL(
    url: string,
    queryParams: { [key: string]: string | undefined }
) {
    const urlEncoded = _.map(queryParams, (val, key) => {
        if (val) {
            return `${key}=${val}`;
        } else {
            return '';
        }
    }).filter((x) => !!x); // take out empty params

    if (urlEncoded.length > 0) {
        return `${url}?${urlEncoded.join('&')}`;
    } else {
        return url;
    }
}

export function getExplorePageURL(
    tab: ExploreTab,
    filters: ExploreSelectedFilter[]
) {
    let url = '/explore';
    if (filters.length > 0) {
        const query: ExploreURLQuery = {
            selectedFilters: urlEncodeSelectedFilters(filters),
            tab,
        }; // using this intermediate container to use typescript to enforce URL correctness
        url = addQueryStringToURL(url, query);
    }
    return url;
}

export function getAtlasPageURL(id: string) {
    return `/atlas/${id}`;
}

export function updateSelectedFiltersInURL(
    filters: ExploreSelectedFilter[],
    router: NextRouter
) {
    router.push(
        {
            pathname: router.pathname,
            query: Object.assign({}, router.query, {
                selectedFilters: urlEncodeSelectedFilters(filters),
            }),
        },
        undefined,
        { shallow: true }
    );
}

export function setTab(tab: string, router: NextRouter) {
    router.push(
        {
            pathname: router.pathname,
            query: Object.assign({}, router.query, { tab }),
        },
        undefined,
        { shallow: true }
    );
}

export type EntityReport = {
    description: string;
    text: string;
};

export function computeDashboardData(files: Entity[]): EntityReport[] {
    const uniqueAtlases = new Set();
    const uniqueOrgans = new Set();
    const uniqueBiospecs = new Set();
    const uniqueCases = new Set();
    for (const file of files) {
        if (file.atlasid) {
            uniqueAtlases.add(file.atlasid);
        }
        for (const biospec of file.biospecimen) {
            uniqueBiospecs.add(biospec.HTANBiospecimenID);
        }
        for (const diag of file.diagnosis) {
            uniqueCases.add(diag.HTANParticipantID);
            uniqueOrgans.add(diag.TissueorOrganofOrigin);
        }
    }
    return [
        { description: 'Atlases', text: uniqueAtlases.size.toString() },
        { description: 'Organs', text: uniqueOrgans.size.toString() },
        { description: 'Cases', text: uniqueCases.size.toString() },
        { description: 'Biospecimens', text: uniqueBiospecs.size.toString() },
    ];
}

export function getFileBase(filename: string) {
    return Path.basename(filename);
}

export function getFileExtension(filename: string) {
    return Path.extname(filename);
}

export function getFilenameWithoutExtension(base: string) {
    return base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
}

export function truncateFilename(
    filename: string,
    leadThreshold: number = 10,
    trailThreshold: number = 5
) {
    const base = getFileBase(filename);
    const ext = getFileExtension(filename);
    const name = getFilenameWithoutExtension(base);

    let displayValue = base;

    if (name.length > leadThreshold + trailThreshold) {
        // get the first <leadThreshold> characters of the name
        const lead = name.slice(0, leadThreshold);
        // get the last <trailThreshold> characters of the name
        const trail = name.slice(-trailThreshold);
        // always keep the extension (everything after the last dot)
        displayValue = `${lead}...${trail}${ext}`;
    }

    return displayValue;
}

export function convertAgeInDaysToYears(ageInDays: number) {
    return Math.round(ageInDays / 365);
}
