'use strict';

const taffy = require('taffydb').taffy;
const util = require('util');

const fs = require('jsdoc/fs');
const path = require('jsdoc/path');
const template = require('jsdoc/template');
const helper = require('jsdoc/util/templateHelper');
const logger = require('jsdoc/util/logger');
const doop = require('jsdoc/util/doop');
const scanner = require('jsdoc/src/scanner');
const filter = require('jsdoc/src/filter');

const htmlsafe = helper.htmlsafe;
const linkto = helper.linkto;
const resolveAuthorLinks = helper.resolveAuthorLinks;
const scopeToPunc = helper.scopeToPunc;
const hasOwnProp = Object.prototype.hasOwnProperty;

// directory to output docs
const OUTDIR = path.normalize(env.opts.destination);

function tutoriallink(tutorial) {
    return helper.toTutorial(tutorial, null, {
        tag: 'em',
        classname: 'disabled',
        prefix: 'Tutorial: '
    });
}

function hashToLink(doclet, hash) {
    if ( !/^(#.+)/.test(hash) ) { return hash; }

    var url = helper.createLink(doclet);

    url = url.replace(/(#.+|$)/, hash);
    return '<a href="' + url + '">' + hash + '</a>';
}

function needsSignature(doclet) {
    // function and class definitions always get a signature
    if (doclet.kind === 'function' || doclet.kind === 'class') {
        return true;

    // typedefs that contain functions get a signature, too
    } else if (doclet.kind === 'typedef' && doclet.type && doclet.type.names && doclet.type.names.length) {
        for (var i = 0, l = doclet.type.names.length; i < l; i++) {
            if (doclet.type.names[i].toLowerCase() === 'function') {
                return true;
            }
        }
    }

    return false;
}

function getSignatureAttributes(item) {
    const attributes = [];

    if (item.optional) {
        attributes.push('opt');
    }

    if (item.nullable === true) {
        attributes.push('nullable');
    } else if (item.nullable === false) {
        attributes.push('non-null');
    }

    return attributes;
}

function updateItemName(item) {
    var attributes = getSignatureAttributes(item);
    var itemName = item.name || '';

    if (item.variable) {
        itemName = '&hellip;' + itemName;
    }

    if (attributes && attributes.length) {
        const idx = attributes.indexOf('opt');
        if (idx !== -1) {
            itemName = `<span class="optional-param">[${itemName}]</span>`;
            attributes.splice(idx, 1);
        }

        if (attributes.length > 0) {
            itemName = util.format('%s<span class="signature-attributes">%s</span>', itemName, attributes.join(', '));
        }
    }

    return itemName;
}

function addParamAttributes(params) {
    return params.filter(function(param) {
        return param.name && param.name.indexOf('.') === -1;
    }).map(updateItemName);
}

function buildItemTypeStrings(item) {
    var types = [];

    if (item && item.type && item.type.names) {
        item.type.names.forEach(function(name) {
            types.push( linkto(name, htmlsafe(name)) );
        });
    }

    return types;
}

function buildAttribsString(attribs) {
    var attribsString = '';

    if (attribs && attribs.length) {
        attribsString = htmlsafe(util.format('(%s) ', attribs.join(', ')));
    }

    return attribsString;
}

function addNonParamAttributes(items) {
    var types = [];

    items.forEach(function(item) {
        types = types.concat( buildItemTypeStrings(item) );
    });

    return types;
}

function addSignatureParams(f) {
    var params = f.params ? addParamAttributes(f.params) : [];
    f.signature = util.format('%s(%s)', (f.signature || ''), params.join(', '));
}

function addSignatureReturns(f) {
    var attribs = [];
    var attribsString = '';
    var returnTypes = [];
    var returnTypesString = '';

    // jam all the return-type attributes into an array. this could create odd results (for example,
    // if there are both nullable and non-nullable return types), but let's assume that most people
    // who use multiple @return tags aren't using Closure Compiler type annotations, and vice-versa.
    if (f.returns) {
        f.returns.forEach(function(item) {
            helper.getAttribs(item).forEach(function(attrib) {
                if (attribs.indexOf(attrib) === -1) {
                    attribs.push(attrib);
                }
            });
        });

        attribsString = buildAttribsString(attribs);
    }

    if (f.returns) {
        returnTypes = addNonParamAttributes(f.returns);
    }
    if (returnTypes.length) {
        returnTypesString = util.format( ' &rarr; %s{%s}', attribsString, returnTypes.join('|') );
    }

    f.signature = '<span class="signature">' + (f.signature || '') + '</span>' +
        '<span class="type-signature">' + returnTypesString + '</span>';
}

function addSignatureTypes(f) {
    var types = f.type ? buildItemTypeStrings(f) : [];

    f.signature = (f.signature || '') + '<span class="type-signature">' +
        (types.length ? ' :' + types.join('|') : '') + '</span>';
}

function addAttribs(f) {
    var attribs = helper.getAttribs(f);
    var attribsString = buildAttribsString(attribs);

    f.attribs = util.format('<span class="type-signature">%s</span>', attribsString);
}

function shortenPaths(files, commonPrefix) {
    Object.keys(files).forEach(function(file) {
        files[file].shortened = files[file].resolved.replace(commonPrefix, '')
            // always use forward slashes
            .replace(/\\/g, '/');
    });

    return files;
}

function getPathFromDoclet(doclet) {
    if (!doclet.meta) {
        return null;
    } else if (doclet.meta.path && doclet.meta.path !== 'null') {
        return path.join(doclet.meta.path, doclet.meta.filename);
    } else {
        return doclet.meta.filename
    }
}

function generate(view, type, title, docs, filename, resolveLinks) {
    const docData = {
        type: type,
        title: title,
        docs: docs
    };

    const outpath = path.join(OUTDIR, filename);
    let html = view.render('container.tmpl', docData);

    if (resolveLinks !== false) {
        // turn {@link foo} into <a href="foodoc.html">foo</a>
        html = helper.resolveLinks(html);
    }

    fs.writeFileSync(outpath, html, 'utf8');
}

function generateSourceFiles(view, sourceFiles, encoding) {
    encoding = encoding || 'utf8';

    Object.keys(sourceFiles).forEach(function(file) {
        var source;
        // links are keyed to the shortened path in each doclet's `meta.shortpath` property
        var sourceOutfile = helper.getUniqueFilename(sourceFiles[file].shortened);
        helper.registerLink(sourceFiles[file].shortened, sourceOutfile);

        try {
            source = {
                kind: 'source',
                code: helper.htmlsafe( fs.readFileSync(sourceFiles[file].resolved, encoding) )
            };
        } catch(e) {
            logger.error('Error while generating source file %s: %s', file, e.message);
        }

        generate(view, 'Source', sourceFiles[file].shortened, [source], sourceOutfile, false);
    });
}

/**
 * Look for classes or functions with the same name as modules (which indicates that the module
 * exports only that class or function), then attach the classes or functions to the `module`
 * property of the appropriate module doclets. The name of each class or function is also updated
 * for display purposes. This function mutates the original arrays.
 *
 * @private
 * @param {Array.<module:jsdoc/doclet.Doclet>} doclets - The array of classes and functions to
 * check.
 * @param {Array.<module:jsdoc/doclet.Doclet>} modules - The array of module doclets to search.
 */
function attachModuleSymbols(doclets, modules) {
    var symbols = {};

    // build a lookup table
    doclets.forEach(function(symbol) {
        symbols[symbol.longname] = symbols[symbol.longname] || [];
        symbols[symbol.longname].push(symbol);
    });

    return modules.map(function(module) {
        if (symbols[module.longname]) {
            module.modules = symbols[module.longname]
                // Only show symbols that have a description. Make an exception for classes, because
                // we want to show the constructor-signature heading no matter what.
                .filter(function(symbol) {
                    return symbol.description || symbol.kind === 'class';
                })
                .map(function(symbol) {
                    symbol = doop(symbol);

                    if (symbol.kind === 'class' || symbol.kind === 'function') {
                        symbol.name = symbol.name.replace('module:', '(require("') + '"))';
                    }

                    return symbol;
                });
        }
    });
}

function linktoTutorial(longName, name) {
    return tutoriallink(name);
}

function linktoExternal(longName, name) {
    return linkto(longName, name.replace(/(^"|"$)/g, ''));
}

function formatExample(example) {
    let caption;
    let code;

    if (example.match(/^\s*<caption>([\s\S]+?)<\/caption>(\s*[\n\r])([\s\S]+)$/i)) {
        caption = RegExp.$1;
        code = RegExp.$3;
    }

    return {
        caption: caption || '',
        code: code || example
    };
}


/**
 * Entrypoint for building docs
 *
 * @param {TAFFY}    taffyData - See <http://taffydb.com>.
 * @param {object}   opts
 * @param {Tutorial} tutorials
 */

exports.publish = function(taffyData, opts, tutorials) {

    const normPath = path.normalize(opts.template);
    const templatePath = path.join(normPath, 'tmpl');

    const view = new template.Template(templatePath);
    const data = helper.prune(taffyData);
    data.sort('longname, version, since');

    const conf = env.conf.templates || {};
    conf.default = conf.default || {};

    // claim some special filenames in advance, so the All-Powerful Overseer of
    // Filename Uniqueness doesn't try to hand them out later
    const indexUrl = helper.getUniqueFilename('index');
    // don't call registerLink() on this one! 'index' is also a valid longname

    const globalUrl = helper.getUniqueFilename('global');
    helper.registerLink('global', globalUrl);


    //
    // Set up templating
    //

    if (conf.default.layoutFile) {
        const filename = path.basename(conf.default.layoutFile);
        const filepath = path.dirname(conf.default.layoutFile);

        view.layout = path.getResourcePath(filepath, filename);
    } else {
        view.layout = 'layout.tmpl';
    }

    helper.setTutorials(tutorials);
    helper.addEventListeners(data);


    //
    // Add template helpers
    //

    view.find = function(query) { return helper.find(data, query); };
    view.linkto = helper.linkto;
    view.resolveAuthorLinks = helper.resolveAuthorLinks;
    view.tutoriallink = tutoriallink;
    view.htmlsafe = helper.htmlsafe;
    view.outputSourceFiles = conf.default && conf.default.outputSourceFiles !== false;
    view.useLongnameInNav = conf.default && conf.default.useLongnameInNav !== false;
    view.hideReturnValues = conf.default && conf.default.hideReturnValues === true;


    //
    // Build up source files
    //

    let sourceFiles = {};
    let sourceFilePaths = [];

    data().each(doclet => {
        doclet.attribs = '';

        if (doclet.examples) {
            doclet.examples = doclet.examples.map(formatExample);
        }

        if (doclet.see) {
            doclet.see = doclet.see.map(item => hashToLink(doclet, item));
        }

        if (doclet.meta) {
            const sourcePath = getPathFromDoclet(doclet);

            sourceFiles[sourcePath] = {
                resolved: sourcePath,
                shortened: null
            };

            if (sourceFilePaths.indexOf(sourcePath) === -1) {
                sourceFilePaths.push(sourcePath);
            }
        }
    });

    if (sourceFilePaths.length) {
        sourceFiles = shortenPaths(sourceFiles, path.commonPrefix(sourceFilePaths));
    }


    //
    // Copy template static files to OUTDIR
    //

    const fromDir = path.join(normPath, 'static');
    const staticFiles = fs.ls(fromDir, 3); // allow recursion 3 directories deep

    staticFiles.forEach(fileName => {
        const toPath = fileName.replace(fromDir, OUTDIR);
        const toDir = fs.toDir(toPath);

        fs.mkPath(toDir);
        fs.copyFileSync(fileName, toPath);
    });


    //
    // Copy user-specified static files to OUTDIR
    //

    if (conf.default.staticFiles) {
        const filePaths = conf.default.staticFiles.include || [];
        const fileFilter = new filter.Filter(conf.default.staticFiles);
        const fileScanner = new scanner.Scanner();

        filePaths.forEach(path => {
            const files = fileScanner.scan([path], 10, fileFilter);
            const sourcePath = fs.toDir(path);

            files.forEach(filename => {
                const destDir = fs.toDir(filename.replace(sourcePath, OUTDIR));

                fs.mkPath(destDir);
                fs.copyFileSync(fileName, destDir);
            });
        });
    }


    //
    // Set doclet information
    //

    data().each(doclet => {
        // register link
        const link = helper.createLink(doclet);
        helper.registerLink(doclet.longname, link);

        // set shortened path
        if (doclet.meta) {
            const path = getPathFromDoclet(doclet);
            const short = sourceFiles[path].shortened;

            if (short) {
                doclet.meta.shortpath = short;
            }
        }

        // set doclet id
        const url = helper.longnameToUrl[doclet.longname];

        if (url.indexOf('#') > -1) {
            doclet.id = helper.longnameToUrl[doclet.longname].split(/#/).pop();
        } else {
            doclet.id = doclet.name;
        }

        // add signature parameters, returns and attriutes
        if (needsSignature(doclet)) {
            addSignatureParams(doclet);
            addSignatureReturns(doclet);
            addAttribs(doclet);
        }

        doclet.ancestors = helper.getAncestorLinks(data, doclet);

        if (doclet.kind === 'member') {
            addSignatureTypes(doclet);
            addAttribs(doclet);
        }

        if (doclet.kind === 'constant') {
            addSignatureTypes(doclet);
            addAttribs(doclet);
            doclet.kind = 'member';
        }
    });


    //
    // Generate source files
    //

    if (view.outputSourceFiles) {
        generateSourceFiles(view, sourceFiles, opts.encoding);
    }

    // index page displays information from package.json and lists files
    const files = helper.find(data, { kind: 'file' });
    const packages = helper.find(data, { kind: 'package' });

    const title = opts.mainpagetitle ? opts.mainpagetitle : 'Main Page';
    const docs = packages.concat([{ kind: 'mainpage', readme: opts.readme, longname: title }]).concat(files);


    //
    // Arrange data
    //

    const members = helper.getMembers(data);
    members.tutorials = tutorials.children;

    const doclets = helper.find(data, { longname: { left: 'module:' } });
    attachModuleSymbols(doclets, members.modules);


    //
    // Generate HTML
    //

    view.members = members;

    generate(view, '', 'Home', docs, indexUrl);

    if (members.globals.length) {
        generate(view, '', 'Global', [{kind: 'globalobj'}], globalUrl);
    }

    Object.keys(helper.longnameToUrl).forEach(longname => {
        generateMember(view, 'Module', members.modules, longname);
        generateMember(view, 'Class', members.classes, longname);
        generateMember(view, 'Namespace', members.namespaces, longname);
        generateMember(view, 'Mixin', members.mixins, longname);
        generateMember(view, 'External', members.externals, longname);
        generateMember(view, 'Interface', members.interfaces, longname);
    });

    function generateMember(view, title, data, longname) {
        const members = helper.find(taffy(data), { longname: longname });
        if (members.length) {
            generate(view, title, members[0].name, members, helper.longnameToUrl[longname]);
        }
    }




    // TODO: move the tutorial functions to templateHelper.js
    function generateTutorial(title, tutorial, filename) {
        var tutorialData = {
            title: title,
            header: tutorial.title,
            content: tutorial.parse(),
            children: tutorial.children
        };

        var tutorialPath = path.join(OUTDIR, filename);
        var html = view.render('tutorial.tmpl', tutorialData);

        // yes, you can use {@link} in tutorials too!
        html = helper.resolveLinks(html); // turn {@link foo} into <a href="foodoc.html">foo</a>
        fs.writeFileSync(tutorialPath, html, 'utf8');
    }

    // tutorials can have only one parent so there is no risk for loops
    function saveChildren(node) {
        node.children.forEach(function(child) {
            generateTutorial('Tutorial: ' + child.title, child, helper.tutorialToUrl(child.name));
            saveChildren(child);
        });
    }

    saveChildren(tutorials);
};
